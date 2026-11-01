ardour {
	["type"]    = "dsp",
	name        = "Mixtools De-Esser",
	category    = "Dynamics",
	license     = "MIT",
	author      = "Fall Guy Consulting",
	description = [[Turns down harsh "s", "sh", and "t" sounds only while they happen. It splits the sound at Frequency and only ever lowers the part above it, only while that part is louder than Threshold, and never by more than Max reduction. Whenever it is not reducing, the output is the input, unchanged. Listen plays only the sound being removed.]]
}

-- The mixtools extension's vocal_sibilance tool runs the same filter,
-- detector, and gain law to predict what this plugin will touch. Keep the two
-- in step.

local BLOCK = 8192
local ATTACK_S = 0.0005
local RELEASE_S = 0.060
local SLOPE = 0.75 -- 4:1 above the threshold

function dsp_ioconfig ()
	return { { audio_in = -1, audio_out = -1 } }
end

function dsp_params ()
	return
	{
		{ ["type"] = "input", name = "Frequency", min = 2000, max = 12000, default = 5500, unit = "Hz", logarithmic = true, doc = "Split point. Only sound above it is ever turned down." },
		{ ["type"] = "input", name = "Threshold", min = -60, max = 0, default = -24, unit = "dB", doc = "The high part is turned down only while it is louder than this." },
		{ ["type"] = "input", name = "Max reduction", min = 0, max = 18, default = 4, unit = "dB", doc = "The most the high part is ever turned down." },
		{ ["type"] = "input", name = "Listen", min = 0, max = 1, default = 0, toggled = true, doc = "Play only the sound being removed." },
		{ ["type"] = "output", name = "Reduction", min = 0, max = 18, unit = "dB" },
	}
end

local rate = 48000
local chn = 0
local lows = {}  -- low-pass filter per channel
local mem = {}   -- scratch buffer per channel for the low part
local env = 0    -- detector envelope, shared by all channels
local att, rel = 0, 0
local cur_freq = -1

function dsp_init (r)
	rate = r
	att = 1 - math.exp (-1 / (ATTACK_S * r))
	rel = 1 - math.exp (-1 / (RELEASE_S * r))
end

function dsp_configure (ins, outs)
	assert (ins:n_audio () == outs:n_audio ())
	chn = ins:n_audio ()
	for c = 1, chn do
		lows[c] = ARDOUR.DSP.Biquad (rate)
		mem[c] = ARDOUR.DSP.DspShm (BLOCK)
	end
	env = 0
	cur_freq = -1
end

function dsp_run (ins, outs, n_samples)
	local ctrl = CtrlPorts:array ()
	if ctrl[1] ~= cur_freq then
		cur_freq = ctrl[1]
		for c = 1, chn do
			lows[c]:compute (ARDOUR.DSP.BiquadType.LowPass, cur_freq, 0.7071067811865476, 0)
		end
	end
	local thr = 10 ^ (ctrl[2] / 20)
	local range = ctrl[3]
	local listen = ctrl[4] > 0
	local most = 0

	local off = 0
	while n_samples > 0 do
		local siz = n_samples
		if siz > BLOCK then siz = BLOCK end

		local x, lo, y = {}, {}, {}
		for c = 1, chn do
			local scratch = mem[c]:to_float (0)
			ARDOUR.DSP.copy_vector (scratch, ins[c]:offset (off), siz)
			lows[c]:run (scratch, siz)
			x[c] = ins[c]:offset (off):array ()
			lo[c] = scratch:array ()
			y[c] = outs[c]:offset (off):array ()
		end

		for i = 1, siz do
			-- The high part is the input minus the low part, so low + high is
			-- exactly the input.
			local det = 0
			for c = 1, chn do
				local h = x[c][i] - lo[c][i]
				if h < 0 then h = -h end
				if h > det then det = h end
			end
			if det > env then env = env + att * (det - env) else env = env + rel * (det - env) end

			local g = 1
			if env > thr then
				local red = SLOPE * 20 * math.log (env / thr, 10)
				if red > range then red = range end
				if red > most then most = red end
				g = 10 ^ (-red / 20)
			end

			for c = 1, chn do
				local l = lo[c][i]
				local h = x[c][i] - l
				if listen then
					y[c][i] = h - g * h
				elseif g < 1 then
					y[c][i] = l + g * h
				elseif ins[c] ~= outs[c] then
					y[c][i] = x[c][i]
				end
			end
		end

		n_samples = n_samples - siz
		off = off + siz
	end
	ctrl[5] = most
end
