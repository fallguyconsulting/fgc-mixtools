#!/bin/bash
# Download, build, package, fix up, sign, and notarize the mixtools build of
# Ardour for macOS (Apple Silicon) using Homebrew libraries.
#
# Usage, from the repository root:
#   ardour/build-ardour.sh                 # full build, ad hoc signature
#   SIGN_IDENTITY="Developer ID Application: Fall Guy LLC (J4R9FTUGW2)" ardour/build-ardour.sh
#   SKIP_BUILD=1 ardour/build-ardour.sh    # reuse the last compile, redo packaging
#   NOTARY_PROFILE=mixtools-notary SIGN_IDENTITY="..." ardour/build-ardour.sh
#                                          # also notarize and staple the disk image
#   NOTARY_PROFILE=mixtools-notary NOTARIZE_ONLY=ardour/dist/Ardour-9.8.0-arm64.dmg ardour/build-ardour.sh
#                                          # notarize an existing signed disk image
#
# The script clones Ardour's source at ARDOUR_TAG into ardour/src the first
# time, and refuses to build a checkout at any other commit.
#
# Notarizing needs a notarytool keychain profile, made once with:
#   xcrun notarytool store-credentials mixtools-notary --apple-id <Apple ID> --team-id J4R9FTUGW2
# It asks for an app-specific password from account.apple.com.
#
# Output: ardour/dist/Ardour-<version>-arm64.dmg. Git ignores src/, dist/, and stage/.
#
# patches/ holds our changes to Ardour's source. They add a session/import_audio
# tool to Ardour's MCP server, bind that server to 127.0.0.1, and refuse requests
# from web pages.
#
# Prerequisites: Xcode, and these Homebrew formulas:
#   glibmm@2.66 cairomm@1.14 pangomm@2.46 libsigc++@2 libsndfile libsamplerate
#   fftw libarchive curl liblo libwebsockets libxml2 lv2 lilv serd sord sratom
#   rubberband taglib vamp-plugin-sdk aubio libogg boost pkgconf pango harfbuzz

set -euo pipefail

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
SRC="$HERE/src"
DIST="$HERE/dist"
ARDOUR_REPO=https://github.com/Ardour/ardour.git
ARDOUR_TAG=9.8
ARDOUR_COMMIT=22ed8656c2533e325322ff11831448e5123e0d4b

# Ardour reads its version from `git describe`, so keep a git checkout.
if [ ! -d "$SRC/.git" ]; then
	git clone --depth 1 --branch "$ARDOUR_TAG" "$ARDOUR_REPO" "$SRC"
fi
head="$(git -C "$SRC" rev-parse HEAD)"
if [ "$head" != "$ARDOUR_COMMIT" ]; then
	echo "$SRC is at $head, not Ardour $ARDOUR_TAG ($ARDOUR_COMMIT)." >&2
	echo "Delete $SRC to download the right source, or update ARDOUR_TAG and ARDOUR_COMMIT." >&2
	exit 1
fi
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
ENTITLEMENTS="$SRC/tools/osx_packaging/entitlements.plist"
BREW=/opt/homebrew

# Homebrew installs these formulas outside its shared folders ("keg-only"),
# so pkg-config needs their folders listed explicitly.
PKG_CONFIG_PATH="$BREW/lib/pkgconfig:$BREW/share/pkgconfig"
for p in glibmm@2.66 cairomm@1.14 pangomm@2.46 libsigc++@2 curl libarchive libxml2 icu4c@79 libffi; do
	PKG_CONFIG_PATH="$PKG_CONFIG_PATH:$BREW/opt/$p/lib/pkgconfig"
done
export PKG_CONFIG_PATH
export CPPFLAGS="-I$BREW/include"
export LDFLAGS="-L$BREW/lib"
# DISABLE_VISIBILITY: Homebrew's glib enables GCC symbol aliases, which the
# macOS linker does not support. Ardour's bundled GTK skips them with this flag.
# libarchive: keg-only, and libardour includes its header without asking
# pkg-config for the path.
export CFLAGS="-DDISABLE_VISIBILITY -I$BREW/opt/libarchive/include"
export CXXFLAGS="$CFLAGS"

if [ -z "${SKIP_BUILD:-}" ]; then
	cd "$SRC"
	# Apply our patches to Ardour's source, skipping any already applied.
	for p in "$HERE"/patches/*.patch; do
		if git apply --reverse --check "$p" 2>/dev/null; then
			echo "already applied: $(basename "$p")"
		else
			git apply "$p"
			echo "applied: $(basename "$p")"
		fi
	done
	python3 ./waf configure --optimize --with-backends=coreaudio --no-lrdf \
		--boost-include="$BREW/opt/boost/include"
	python3 ./waf -j"$(sysctl -n hw.ncpu)"
	cd tools/osx_packaging
	rm -f Ardour-*.dmg
	./osx_build --public --stack "$BREW"
fi

RAW_DMG="$(ls -t "$SRC"/tools/osx_packaging/Ardour-*-arm64.dmg | head -1)"
NAME="$(basename "$RAW_DMG" .dmg)"
STAGE="$HERE/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST"

# Copy the apps out of the packaging script's disk image.
MNT="$(hdiutil attach -nobrowse -readonly "$RAW_DMG" | grep -o '/Volumes/.*' | head -1)"
cp -R "$MNT/Ardour9.app" "$MNT/Jadeo.app" "$STAGE/"
hdiutil detach "$MNT" >/dev/null

is_macho() { file "$1" | grep -q 'Mach-O'; }

# The packaging script copies libraries referenced by absolute paths, but not
# ones referenced through @rpath. Copy any that are missing from Homebrew,
# repeating until every reference resolves.
fix_rpath_libs() {
	local app="$1" lib="$1/Contents/lib" changed=1
	while [ $changed -eq 1 ]; do
		changed=0
		while IFS= read -r f; do
			is_macho "$f" || continue
			for ref in $(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep '^@rpath/' || true); do
				local base="${ref#@rpath/}"
				[ -e "$lib/$base" ] && continue
				[ -e "$BREW/lib/$base" ] || { echo "cannot resolve $ref for $f" >&2; exit 1; }
				echo "adding missing library: $base"
				cp "$(realpath "$BREW/lib/$base")" "$lib/$base"
				chmod u+w "$lib/$base"
				install_name_tool -id "@rpath/$base" "$lib/$base" 2>/dev/null
				changed=1
			done
		done < <(find "$app/Contents" -type f)
	done
}

# Sign the helper scripts, then every other binary (deepest paths first), then
# the bundle, which signs the main executable last. install_name_tool
# invalidates the linker's signatures, and Apple Silicon refuses to run code
# with a broken signature.
sign_app() {
	local app="$1" opts=(--force --sign "$SIGN_IDENTITY")
	local main="$app/Contents/MacOS/$(defaults read "$app/Contents/Info" CFBundleExecutable)"
	if [ "$SIGN_IDENTITY" != "-" ]; then
		opts+=(--timestamp --options runtime --entitlements "$ENTITLEMENTS")
	fi
	while IFS= read -r f; do
		is_macho "$f" || codesign "${opts[@]}" "$f"
	done < <(find "$app/Contents/MacOS" -type f)
	while IFS= read -r f; do
		[ "$f" = "$main" ] && continue
		is_macho "$f" && codesign "${opts[@]}" "$f"
	done < <(find "$app/Contents" -type f | awk '{print length, $0}' | sort -rn | cut -d' ' -f2-)
	codesign "${opts[@]}" "$app"
	codesign --verify --deep --strict "$app"
}

for app in "$STAGE"/*.app; do
	fix_rpath_libs "$app"
	sign_app "$app"
	echo "signed: $(basename "$app")"
done

# Check that no binary still points outside the bundle.
outside=0
while IFS= read -r f; do
	is_macho "$f" || continue
	if otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -qE "^($BREW|/usr/local|/Users)/"; then
		echo "outside reference in $f" >&2
		outside=1
	fi
done < <(find "$STAGE" -type f)
[ $outside -eq 0 ] || exit 1

ln -s /Applications "$STAGE/Applications"
OUT="$DIST/$NAME.dmg"
rm -f "$OUT"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -format UDZO -imagekey zlib-level=9 "$OUT" >/dev/null
[ "$SIGN_IDENTITY" != "-" ] && codesign --force --timestamp --sign "$SIGN_IDENTITY" "$OUT"
rm -rf "$STAGE"

[ -n "${NOTARY_PROFILE:-}" ] && notarize "$OUT"
echo "done: $OUT"
