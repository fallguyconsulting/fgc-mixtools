#!/bin/bash
# Download, build, package, sign, and notarize the mixtools build of Ardour for
# macOS as one universal app that runs on Apple silicon and Intel Macs.
#
# Usage, from the repository root:
#   ardour/build-ardour.sh                 # universal build, ad hoc signature
#   ARCHS=x86_64 ardour/build-ardour.sh    # one architecture only (arm64 or x86_64)
#   SIGN_IDENTITY="Developer ID Application: Fall Guy LLC (J4R9FTUGW2)" ardour/build-ardour.sh
#   SKIP_BUILD=1 ardour/build-ardour.sh    # reuse the last compiles, redo packaging
#   BUILD_ONLY=1 ARCHS=x86_64 ardour/build-ardour.sh
#                                          # compile one architecture, no packaging;
#                                          # run one per architecture side by side,
#                                          # then package with SKIP_BUILD=1
#   NOTARY_PROFILE=mixtools-notary SIGN_IDENTITY="..." ardour/build-ardour.sh
#                                          # also notarize and staple the disk image
#   NOTARY_PROFILE=mixtools-notary NOTARIZE_ONLY=ardour/dist/Ardour-<version>-universal.dmg ardour/build-ardour.sh
#                                          # notarize an existing signed disk image
#
# For each architecture the script:
#   1. builds Ardour's library stack (GTK, glib, boost, and about 70 more) into
#      ardour/stack/<arch> with Ardour's own build-stack recipe, pinned to
#      BUILD_TOOLS_COMMIT. The libraries run on macOS 11 and later. This runs
#      once; later runs reuse the stack.
#   2. clones our fork of Ardour at ARDOUR_COMMIT into ardour/src/<arch>,
#      compiles it, and packages it with Ardour's osx_build.
# It then merges the two apps into one universal app, checks every binary,
# signs the app, and writes the disk image.
#
# Intel binaries build under Rosetta, so an Apple silicon Mac needs Rosetta:
#   softwareupdate --install-rosetta --agree-to-license
#
# Notarizing needs a notarytool keychain profile, made once with:
#   xcrun notarytool store-credentials mixtools-notary --apple-id <Apple ID> --team-id J4R9FTUGW2
# It asks for an app-specific password from account.apple.com.
#
# Output: ardour/dist/Ardour-<version>-universal.dmg (or -<arch>.dmg for one
# architecture). Git ignores src/, stack/, dist/, and stage/.
#
# Our changes to Ardour live in our fork, github.com/fallguyconsulting/ardour,
# on the mixtools branch. That branch starts at Ardour's release tag and adds one
# commit per change. Ardour numbers its version from `git describe`, so a build
# of the branch reports <release>.<commits since the tag>, for example 9.8.1.
# To ship a change: commit it to the fork's mixtools branch, push, and set
# ARDOUR_COMMIT below to the new commit.
#
# Prerequisites: Xcode, git, and Rosetta for Intel builds. Homebrew is not used;
# the build runs with a minimal PATH so Homebrew's libraries cannot leak in.

set -euo pipefail

# Bash reads a script as it runs it. The braces make bash read the whole script
# first, so editing this file during a long build cannot change that build.
{

# Send a signed disk image to Apple's notary service, wait for the result,
# attach the ticket to the image, and check that Gatekeeper accepts it.
# Without a ticket, macOS blocks the app on any Mac that downloads it.
notarize() {
	local dmg="$1"
	xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait \
		| tee /dev/stderr | grep 'status: Accepted' >/dev/null || {
		echo "notarization failed; run: xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE" >&2
		exit 1
	}
	xcrun stapler staple "$dmg"
	xcrun stapler validate "$dmg"
	spctl -a -t open --context context:primary-signature -v "$dmg"
}

if [ -n "${NOTARIZE_ONLY:-}" ]; then
	: "${NOTARY_PROFILE:?set NOTARY_PROFILE to a notarytool keychain profile}"
	notarize "$NOTARIZE_ONLY"
	exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
STACKS="$HERE/stack"
ARCHS="${ARCHS:-arm64 x86_64}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
MIN_MACOS=11.0
JOBS="$(sysctl -n hw.ncpu)"

ARDOUR_REPO=git@github.com:fallguyconsulting/ardour.git
ARDOUR_BRANCH=mixtools
ARDOUR_COMMIT=9df93b9542015154dbc7e29f8fd6759b490b255b
# Ardour's own recipe for its library stack. This commit is the one Ardour's
# official Intel Mac builds use.
BUILD_TOOLS_REPO=git://git.ardour.org/ardour/ardour-build-tools.git
BUILD_TOOLS_COMMIT=8e0ae1cb36f89658458e1cde86555b84e35aa2d9

for arch in $ARCHS; do
	case "$arch" in arm64|x86_64) ;; *) echo "unknown architecture: $arch" >&2; exit 1 ;; esac
done
if [[ " $ARCHS " == *" x86_64 "* ]] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
	echo "Intel builds need Rosetta: softwareupdate --install-rosetta --agree-to-license" >&2
	exit 1
fi

# Xcode's compiler is an Apple silicon program only, so under Rosetta it still
# makes Apple silicon code unless told otherwise. These wrappers pass the
# architecture on every call. They live in $HOME/bin, which build-stack puts
# first on its PATH.
make_wrappers() {
	local arch="$1" dir="$STACKS/$1/bin" tool
	mkdir -p "$dir"
	for tool in cc gcc clang; do
		printf '#!/bin/sh\nexec /usr/bin/clang -arch %s "$@"\n' "$arch" > "$dir/$tool"
	done
	for tool in c++ g++ clang++; do
		printf '#!/bin/sh\nexec /usr/bin/clang++ -arch %s "$@"\n' "$arch" > "$dir/$tool"
	done
	chmod +x "$dir"/*
}

# Run a command for one architecture with a minimal environment: no Homebrew,
# the architecture's compiler wrappers first on PATH, then the stack's tools.
# Rosetta runs the Intel builds, so configure scripts see an Intel Mac.
in_arch() {
	local arch="$1" prefix="$STACKS/$1/gtk/inst"
	shift
	make_wrappers "$arch"
	env -i HOME="$STACKS/$arch" USER="$USER" TERM=dumb LANG=en_US.UTF-8 \
		PATH="$STACKS/$arch/bin:$prefix/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
		PKG_CONFIG_PATH="$prefix/lib/pkgconfig" \
		arch -"$arch" "$@"
}

fetch_build_tools() {
	local tools="$STACKS/tools"
	[ -d "$tools/.git" ] || git clone "$BUILD_TOOLS_REPO" "$tools"
	git -C "$tools" cat-file -e "$BUILD_TOOLS_COMMIT" 2>/dev/null || git -C "$tools" fetch origin
	git -C "$tools" checkout -q "$BUILD_TOOLS_COMMIT"
}

# Write this architecture's copy of build-stack next to the original, which
# it needs for its patch folders. Each architecture gets its own copy because
# bash reads a script as it runs it, so a running build's file must not change.
# The copy changes two things:
# - build-stack's last step points libxml2 and three other libraries at the
#   stack's libiconv instead of macOS's. Our stack folder's path is longer than
#   the space the linker left in libxml2, so that change fails and stops the
#   build. A library that keeps macOS's libiconv still works, so the copy lets
#   that step fail without stopping the build.
# - build-stack runs boost's build tool with /usr/bin first on PATH, ahead of
#   our compiler wrappers in $HOME/bin, so boost came out as Apple silicon code
#   in Intel builds. The copy puts $HOME/bin first there too.
patched_build_stack() {
	local out="$STACKS/tools/build-stack-$1"
	sed -E \
		-e 's#^(  install_name_tool -change /usr/lib/libiconv\.2\.dylib .*)$#\1 || echo "kept macOS libiconv in the line above"#' \
		-e 's#^(  )PATH=/usr/bin:\$PATH \./b2 #\1PATH=$HOME/bin:/usr/bin:$PATH ./b2 #' \
		"$STACKS/tools/build-stack" > "$out"
	[ "$(grep -c 'kept macOS libiconv' "$out")" = 4 ] && grep -q 'PATH=$HOME/bin:/usr/bin:$PATH ./b2' "$out" \
		|| { echo "build-stack changed; update patched_build_stack" >&2; exit 1; }
	echo "$out"
}

# Build Ardour's library stack for one architecture, once. build-stack installs
# into $HOME/gtk/inst and reads $HOME/.ardour-build-stack.rc, so HOME points at
# the architecture's stack folder.
build_stack() {
	local arch="$1" root="$STACKS/$1"
	local done_mark="$root/gtk/inst/.mixtools-stack-$BUILD_TOOLS_COMMIT"
	[ -f "$done_mark" ] && { echo "stack $arch: already built"; return; }
	fetch_build_tools
	seed_cache "$root/src-cache"
	# Start clean: a half-built stack can hold files from a failed run.
	rm -rf "$root/build" "$root/gtk"
	mkdir -p "$root/build"
	printf 'SRCCACHE=%s/\n' "$root/src-cache" > "$root/.ardour-build-stack.rc"
	echo "stack $arch: building, log in $root/build.log"
	local recipe
	recipe="$(patched_build_stack "$arch")"
	(cd "$root/build" && in_arch "$arch" /bin/bash "$recipe" --overridepath -j"$JOBS") \
		> "$root/build.log" 2>&1 || { echo "stack $arch failed; see $root/build.log" >&2; tail -30 "$root/build.log" >&2; exit 1; }
	local f
	for f in lib/pkgconfig/glibmm-2.4.pc lib/pkgconfig/lilv-0.pc lib/pkgconfig/sndfile.pc include/boost/version.hpp; do
		[ -e "$root/gtk/inst/$f" ] || { echo "stack $arch is missing $f; see $root/build.log" >&2; exit 1; }
	done
	touch "$done_mark"
}

# build-stack downloads each library from the address in its recipe, and saves
# whatever comes back, even an error page. Put a good copy in the cache first
# for each address that no longer works; build-stack keeps a cached archive.
SOURCE_FIXES=(
	"expat-2.8.4.tar.xz https://github.com/libexpat/libexpat/releases/download/R_2_8_4/expat-2.8.4.tar.xz"
)
seed_cache() {
	local cache="$1" fix name url
	mkdir -p "$cache"
	for fix in "${SOURCE_FIXES[@]}"; do
		name="${fix%% *}" url="${fix#* }"
		file -b "$cache/$name" 2>/dev/null | grep -q compressed && continue
		curl -fsSL -o "$cache/$name" "$url"
	done
}

# Clone our fork of Ardour for one architecture and check out ARDOUR_COMMIT.
# Ardour reads its version from `git describe`, which needs the commits and tags
# back to the release. A blobless clone has them all but downloads file contents
# only for the commit checked out.
fetch_source() {
	local src="$HERE/src/$1" origin
	if [ ! -d "$src/.git" ]; then
		git clone --filter=blob:none --no-checkout "$ARDOUR_REPO" "$src"
		git -C "$src" checkout -q "$ARDOUR_COMMIT"
		return
	fi
	origin="$(git -C "$src" remote get-url origin)"
	if [ "$origin" != "$ARDOUR_REPO" ]; then
		echo "$src is a clone of $origin, not $ARDOUR_REPO. Delete $src and run again." >&2
		exit 1
	fi
	if [ -n "$(git -C "$src" status --porcelain --untracked-files=no)" ]; then
		echo "$src has changes to Ardour's files. Commit them to the fork's $ARDOUR_BRANCH branch, or delete $src." >&2
		exit 1
	fi
	git -C "$src" cat-file -e "$ARDOUR_COMMIT^{commit}" 2>/dev/null || git -C "$src" fetch --tags origin
	git -C "$src" checkout -q "$ARDOUR_COMMIT"
}

build_ardour() {
	local arch="$1" src="$HERE/src/$1" archflag=--arm64
	[ "$arch" = arm64 ] || archflag=
	cd "$src"
	in_arch "$arch" /usr/bin/python3 ./waf configure --optimize --with-backends=coreaudio \
		--depstack-root="$STACKS/$arch" ${archflag:+"$archflag"}
	in_arch "$arch" /usr/bin/python3 ./waf -j"$JOBS"
	cd tools/osx_packaging
	rm -f Ardour-*.dmg
	in_arch "$arch" /bin/bash ./osx_build --public --stack "$STACKS/$arch/gtk/inst"
	cd "$HERE"
}

if [ -z "${SKIP_BUILD:-}" ]; then
	for arch in $ARCHS; do
		build_stack "$arch"
		fetch_source "$arch"
		build_ardour "$arch"
	done
fi
[ -n "${BUILD_ONLY:-}" ] && { echo "built: $ARCHS"; exit 0; }

STAGE="$HERE/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST"

# Copy each architecture's apps out of the packaging script's disk image.
VERSION=
for arch in $ARCHS; do
	raw="$(ls -t "$HERE/src/$arch"/tools/osx_packaging/Ardour-*-"$arch".dmg | head -1)"
	VERSION="$(basename "$raw" .dmg | sed -E "s/^Ardour-(.*)-$arch\$/\1/")"
	mkdir -p "$STAGE/$arch"
	mnt="$(hdiutil attach -nobrowse -readonly "$raw" | grep -o '/Volumes/.*' | head -1)"
	cp -R "$mnt/Ardour9.app" "$mnt/Jadeo.app" "$STAGE/$arch/"
	hdiutil detach "$mnt" >/dev/null
done

is_macho() { file "$1" | grep -q 'Mach-O'; }

# Merge the same app from two architectures into one universal app: binaries
# found in both become universal binaries; other files must match.
merge_app() {
	local a="$1" b="$2" out="$3" rel fa fb fo archs
	cp -R "$a" "$out"
	while IFS= read -r rel; do
		fa="$a/$rel" fb="$b/$rel" fo="$out/$rel"
		if [ ! -e "$fa" ]; then
			mkdir -p "$(dirname "$fo")"
			cp -p "$fb" "$fo"
			echo "only in $(basename "$(dirname "$b")"): $rel"
		elif is_macho "$fa" && is_macho "$fb"; then
			archs="$(lipo -archs "$fa") $(lipo -archs "$fb")"
			local parts=() arch
			for arch in arm64 x86_64; do
				if lipo -archs "$fa" | tr ' ' '\n' | grep -qx "$arch"; then
					parts+=("$fa")
				elif lipo -archs "$fb" | tr ' ' '\n' | grep -qx "$arch"; then
					parts+=("$fb")
				else
					echo "no $arch code for $rel (archs: $archs)" >&2
					exit 1
				fi
			done
			local tmp="$STAGE/.lipo"
			mkdir -p "$tmp"
			lipo_thin "${parts[0]}" arm64 "$tmp/a"
			lipo_thin "${parts[1]}" x86_64 "$tmp/b"
			lipo -create "$tmp/a" "$tmp/b" -output "$fo"
			rm -f "$tmp/a" "$tmp/b"
		elif ! cmp -s "$fa" "$fb"; then
			echo "differs between architectures, kept $(basename "$(dirname "$a")"): $rel"
		fi
	done < <(cd "$b" && find . -type f | sed 's#^\./##')
	rm -rf "$STAGE/.lipo"
}

# Write one architecture of a binary to a file, whether the binary is thin or
# universal.
lipo_thin() {
	if [ "$(lipo -archs "$1")" = "$2" ]; then
		cp "$1" "$3"
	else
		lipo "$1" -thin "$2" -output "$3"
	fi
}

set -- $ARCHS
if [ $# -eq 2 ]; then
	NAME="Ardour-$VERSION-universal"
	for app in Ardour9.app Jadeo.app; do
		merge_app "$STAGE/arm64/$app" "$STAGE/x86_64/$app" "$STAGE/$app"
	done
else
	NAME="Ardour-$VERSION-$1"
	mv "$STAGE/$1/"*.app "$STAGE/"
fi
for arch in $ARCHS; do rm -rf "$STAGE/$arch"; done

# Copy libraries that a binary loads through @rpath but the packaging script
# left out, from the stack, repeating until every reference resolves.
fix_rpath_libs() {
	local app="$1" lib="$1/Contents/lib" changed=1 base found arch
	while [ $changed -eq 1 ]; do
		changed=0
		while IFS= read -r f; do
			is_macho "$f" || continue
			for ref in $(otool -L "$f" | awk 'NR>1 {print $1}' | grep '^@rpath/' | sort -u || true); do
				base="${ref#@rpath/}"
				[ -e "$lib/$base" ] && continue
				found=
				for arch in $ARCHS; do
					[ -e "$STACKS/$arch/gtk/inst/lib/$base" ] && found="$STACKS/$arch/gtk/inst/lib/$base"
				done
				[ -n "$found" ] || { echo "cannot resolve $ref for $f" >&2; exit 1; }
				echo "adding missing library: $base"
				cp "$(realpath "$found")" "$lib/$base"
				chmod u+w "$lib/$base"
				install_name_tool -id "@rpath/$base" "$lib/$base" 2>/dev/null
				changed=1
			done
		done < <(find "$app/Contents" -type f)
	done
}

# Check every binary, one architecture's code at a time:
# - each app's main program holds code for every architecture in ARCHS;
# - the code asks for no newer macOS than MIN_MACOS;
# - it loads nothing from outside the app, and each bundled library it loads
#   holds code for the same architecture.
# A library may hold one architecture's code only. The Intel and Apple silicon
# Jadeo builds bundle different FFmpeg versions, so each keeps its own copies,
# and only that architecture's code loads them.
check_binaries() {
	local bad=0 f arch minos ref base archs id index="$STAGE/.archs"
	: > "$index"
	while IFS= read -r f; do
		is_macho "$f" && printf '%s\t%s\n' "$(basename "$f")" "$(lipo -archs "$f")" >> "$index"
	done < <(find "$STAGE" -type f)
	for f in "$STAGE"/*.app/Contents/MacOS/*; do
		is_macho "$f" || continue
		for arch in $ARCHS; do
			lipo -archs "$f" | tr ' ' '\n' | grep -qx "$arch" || { echo "no $arch code in main program: $f" >&2; bad=1; }
		done
	done
	while IFS= read -r f; do
		is_macho "$f" || continue
		for arch in $(lipo -archs "$f"); do
			minos="$(otool -arch "$arch" -l "$f" | awk '/LC_BUILD_VERSION/{b=1} /LC_VERSION_MIN_MACOSX/{v=1} b&&/minos/{print $2; exit} v&&/version/{print $2; exit}')"
			if [ -n "$minos" ] && [ "$(printf '%s\n%s\n' "$minos" "$MIN_MACOS" | sort -V | tail -1)" != "$MIN_MACOS" ]; then
				echo "needs macOS $minos ($arch): $f" >&2
				bad=1
			fi
			# otool -L lists a library's own name first; that is not a load.
			id="$(otool -arch "$arch" -D "$f" | awk 'NR==2 {print $1}')"
			for ref in $(otool -arch "$arch" -L "$f" | awk 'NR>1 && !/:$/ {print $1}'); do
				[ "$ref" = "$id" ] && continue
				case "$ref" in
				/usr/lib/*|/System/*) ;;
				@*)
					base="$(basename "$ref")"
					archs="$(awk -F '\t' -v b="$base" '$1==b {print $2}' "$index" | tr '\n' ' ')"
					if [ -z "$archs" ]; then
						echo "$arch code loads $base, which is not in the app: $f" >&2
						bad=1
					elif ! printf '%s\n' $archs | grep -qx "$arch"; then
						echo "$arch code loads $base, which has only $archs code: $f" >&2
						bad=1
					fi
					;;
				*)
					echo "$arch code loads $ref from outside the app: $f" >&2
					bad=1
					;;
				esac
			done
		done
	done < <(find "$STAGE" -type f)
	rm -f "$index"
	[ $bad -eq 0 ] || exit 1
	echo "binaries: main programs hold $ARCHS code; all code needs macOS $MIN_MACOS or earlier and loads only bundled libraries of its own architecture"
}

# Sign every binary (deepest paths first), then the helper scripts, then the
# bundle, which signs the main executable last. lipo and install_name_tool
# invalidate the linker's signatures, and macOS refuses to run code with a
# broken signature.
ENTITLEMENTS="$HERE/src/$1/tools/osx_packaging/entitlements.plist"
sign_app() {
	local app="$1" opts=(--force --sign "$SIGN_IDENTITY")
	local main="$app/Contents/MacOS/$(defaults read "$app/Contents/Info" CFBundleExecutable)"
	if [ "$SIGN_IDENTITY" != "-" ]; then
		opts+=(--timestamp --options runtime --entitlements "$ENTITLEMENTS")
	fi
	while IFS= read -r f; do
		[ "$f" = "$main" ] && continue
		is_macho "$f" && codesign "${opts[@]}" "$f"
	done < <(find "$app/Contents" -type f | awk '{print length, $0}' | sort -rn | cut -d' ' -f2-)
	# Sign helper scripts after the binaries: signing a script that is a
	# bundle's main program checks every library in the bundle.
	while IFS= read -r f; do
		[ "$f" = "$main" ] && continue
		is_macho "$f" || codesign "${opts[@]}" "$f"
	done < <(find "$app/Contents/MacOS" -type f)
	codesign "${opts[@]}" "$app"
	codesign --verify --deep --strict "$app"
}

for app in "$STAGE"/*.app; do
	fix_rpath_libs "$app"
done
check_binaries
for app in "$STAGE"/*.app; do
	sign_app "$app"
	echo "signed: $(basename "$app")"
done

ln -s /Applications "$STAGE/Applications"
OUT="$DIST/$NAME.dmg"
rm -f "$OUT"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -format UDZO -imagekey zlib-level=9 "$OUT" >/dev/null
[ "$SIGN_IDENTITY" != "-" ] && codesign --force --timestamp --sign "$SIGN_IDENTITY" "$OUT"
rm -rf "$STAGE"

[ -n "${NOTARY_PROFILE:-}" ] && notarize "$OUT"
echo "done: $OUT"
exit 0
}
