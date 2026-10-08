/**
 * FFmpeg helpers for the URL → video pipeline: image crops, Ken Burns scene clips,
 * concat, procedural (royalty-free) music + whoosh SFX, and the final audio mix.
 */
import { execFile } from "child_process";
import fsp from "fs/promises";
import path from "path";

export const FPS = 30;

function ffmpegBin() {
	return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function ffprobeBin() {
	return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

function run(bin, args, label, timeout = 600_000) {
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			{ timeout, maxBuffer: 50 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const hint =
						err.code === "ENOENT"
							? ` Install ${bin} on the host or set FFMPEG_PATH / FFPROBE_PATH.`
							: "";
					const se = stderr ? String(stderr).slice(-3000) : "";
					reject(new Error(`${label}: ${err.message}${hint}${se ? `\n${se}` : ""}`));
					return;
				}
				resolve(String(stdout || ""));
			},
		);
	});
}

export function ffmpeg(args, label) {
	return run(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], label);
}

/** @returns {Promise<{ width: number, height: number }>} */
export async function probeImageSize(file) {
	const out = await run(
		ffprobeBin(),
		["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file],
		"ffprobe image size",
		30_000,
	);
	const [w, h] = out.trim().split("x").map(Number);
	if (!w || !h) throw new Error(`Unable to read image size of ${path.basename(file)}`);
	return { width: w, height: h };
}

export async function probeDurationSec(file) {
	const out = await run(
		ffprobeBin(),
		["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
		"ffprobe duration",
		30_000,
	);
	const sec = Number.parseFloat(out.trim());
	return Number.isFinite(sec) ? sec : 0;
}

export async function cropImage(input, output, { x, y, width, height }) {
	await ffmpeg(
		["-i", input, "-vf", `crop=${width}:${height}:${x}:${y}`, "-frames:v", "1", output],
		"ffmpeg crop",
	);
}

/** Downscaled JPEG for vision models (keeps request size small). */
export async function toPreviewJpeg(input, output, maxWidth = 1024) {
	await ffmpeg(
		["-i", input, "-vf", `scale='min(${maxWidth},iw)':-2`, "-q:v", "4", "-frames:v", "1", output],
		"ffmpeg preview",
	);
}

/**
 * Turn one still frame into a scene clip with a camera move.
 * @param {{ input: string, output: string, durationSec: number, width: number, height: number,
 *   motion?: string, focus?: { x: number, y: number } }} p
 */
export async function renderSceneClip({ input, output, durationSec, width, height, motion = "zoom_in", focus }) {
	const frames = Math.max(1, Math.round(durationSec * FPS));
	const fx = clamp01(focus?.x ?? 0.5);
	const fy = clamp01(focus?.y ?? 0.5);
	const maxZ = 1.12;
	const step = ((maxZ - 1) / frames).toFixed(6);
	// Centre the crop window on the focus point while staying inside the frame.
	const xExpr = `max(0,min(iw-iw/zoom,${fx}*iw-iw/zoom/2))`;
	const yExpr = `max(0,min(ih-ih/zoom,${fy}*ih-ih/zoom/2))`;
	let z;
	let x = xExpr;
	let y = yExpr;
	switch (motion) {
		case "zoom_out":
			z = `max(${maxZ}-on*${step},1)`;
			break;
		case "pan_down":
			z = "1.15";
			x = "(iw-iw/zoom)/2";
			y = `(ih-ih/zoom)*on/${frames}`;
			break;
		case "pan_up":
			z = "1.15";
			x = "(iw-iw/zoom)/2";
			y = `(ih-ih/zoom)*(1-on/${frames})`;
			break;
		case "static":
			z = `1+on*${(0.02 / frames).toFixed(6)}`;
			break;
		default:
			z = `min(1+on*${step},${maxZ})`;
	}
	const fade = Math.min(0.35, durationSec / 4).toFixed(2);
	const fadeOutStart = Math.max(0, durationSec - Number(fade)).toFixed(2);
	// Upscale 2x before zoompan so sub-pixel motion does not jitter.
	const vf = [
		`scale=${width * 2}:${height * 2}:flags=lanczos`,
		`zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${FPS}`,
		`fade=t=in:st=0:d=${fade}`,
		`fade=t=out:st=${fadeOutStart}:d=${fade}`,
		"format=yuv420p",
	].join(",");
	await ffmpeg(
		["-loop", "1", "-i", input, "-vf", vf, "-frames:v", String(frames), "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", output],
		"ffmpeg scene clip",
	);
}

export async function concatClips(clips, output, workDir) {
	const listFile = path.join(workDir, "concat.txt");
	await fsp.writeFile(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
	await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output], "ffmpeg concat");
}

/** Pad/trim a narration file to an exact scene length (stereo 44.1 kHz). */
export async function fitAudioToDuration(input, output, durationSec, leadInSec = 0.25) {
	const delayMs = Math.round(leadInSec * 1000);
	await ffmpeg(
		["-i", input, "-af", `aresample=44100,aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad,atrim=0:${durationSec.toFixed(3)}`, "-c:a", "pcm_s16le", output],
		"ffmpeg fit narration",
	);
}

export async function silence(output, durationSec) {
	await ffmpeg(
		["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", durationSec.toFixed(3), "-c:a", "pcm_s16le", output],
		"ffmpeg silence",
	);
}

export async function concatAudio(files, output, workDir) {
	const listFile = path.join(workDir, "concat-audio.txt");
	await fsp.writeFile(listFile, files.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
	await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "pcm_s16le", output], "ffmpeg concat audio");
}

const MOOD_PROGRESSIONS = {
	// Root frequencies (Hz) of a four-chord loop; each chord = root, major/minor third, fifth, octave.
	uplifting: [[261.63, "maj"], [196.0, "maj"], [220.0, "min"], [174.61, "maj"]], // C G Am F
	energetic: [[220.0, "min"], [174.61, "maj"], [261.63, "maj"], [196.0, "maj"]], // Am F C G
	calm: [[174.61, "maj7"], [220.0, "min7"], [196.0, "maj"], [261.63, "maj7"]],
	cinematic: [[146.83, "min"], [116.54, "maj"], [174.61, "maj"], [130.81, "maj"]], // Dm Bb F C
	techy: [[164.81, "min"], [130.81, "maj"], [196.0, "maj"], [146.83, "maj"]], // Em C G D
	playful: [[196.0, "maj"], [246.94, "min"], [261.63, "maj"], [293.66, "maj"]],
};
const INTERVALS = { maj: [1, 1.26, 1.498, 2], min: [1, 1.189, 1.498, 2], maj7: [1, 1.26, 1.498, 1.888], min7: [1, 1.189, 1.498, 1.782] };

/**
 * Procedurally generated ambient pad + soft pulse — free, offline, no licensing.
 * @param {{ output: string, durationSec: number, mood?: string, bpm?: number }} p
 */
export async function generateMusic({ output, durationSec, mood = "uplifting", bpm = 100 }) {
	const prog = MOOD_PROGRESSIONS[mood] || MOOD_PROGRESSIONS.uplifting;
	const beat = 60 / Math.min(140, Math.max(70, Number(bpm) || 100));
	const chordLen = beat * 8; // two bars per chord
	const cycle = chordLen * prog.length;
	// Each chord is gated by a smooth window so frequency changes never click.
	const terms = prog.map(([root, quality], i) => {
		const tones = INTERVALS[quality]
			.map((m, k) => `${(0.5 / (k + 1)).toFixed(3)}*sin(2*PI*${(root * m).toFixed(2)}*t)`)
			.join("+");
		const gate = `between(mod(t,${cycle.toFixed(3)}),${(i * chordLen).toFixed(3)},${((i + 1) * chordLen).toFixed(3)})*pow(sin(PI*mod(t,${chordLen.toFixed(3)})/${chordLen.toFixed(3)}),0.6)`;
		return `${gate}*(${tones})`;
	});
	const bassTerms = prog.map(([root], i) => {
		const gate = `between(mod(t,${cycle.toFixed(3)}),${(i * chordLen).toFixed(3)},${((i + 1) * chordLen).toFixed(3)})`;
		// Plucked bass note on every beat: exponential decay envelope.
		return `${gate}*0.35*exp(-6*mod(t,${beat.toFixed(4)}))*sin(2*PI*${(root / 2).toFixed(2)}*t)`;
	});
	const expr = `0.22*(${terms.join("+")})+${bassTerms.join("+")}`;
	const fadeOut = Math.max(0, durationSec - 2.5).toFixed(2);
	await ffmpeg(
		["-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=${durationSec.toFixed(2)}`, "-af", `lowpass=f=2400,aecho=0.8:0.6:60|120:0.25|0.15,afade=t=in:d=1.5,afade=t=out:st=${fadeOut}:d=2.5,aformat=channel_layouts=stereo,volume=0.9`, "-c:a", "pcm_s16le", output],
		"ffmpeg generate music",
	);
}

/** Short filtered-noise whoosh for scene transitions. */
export async function generateWhoosh(output) {
	await ffmpeg(
		["-f", "lavfi", "-i", "anoisesrc=d=0.7:c=pink:r=44100:a=0.6", "-af", "highpass=f=400,lowpass=f=5000,afade=t=in:d=0.35:curve=exp,afade=t=out:st=0.35:d=0.35,aformat=channel_layouts=stereo,volume=0.35", "-c:a", "pcm_s16le", output],
		"ffmpeg whoosh",
	);
}

/**
 * Mix narration (full length), music (looped + ducked under the voice) and transition whooshes.
 * @param {{ narration: string, music?: string|null, whoosh?: string|null, whooshAtSec?: number[],
 *   durationSec: number, output: string, musicVolume?: number }} p
 */
export async function mixAudio({ narration, music, whoosh, whooshAtSec = [], durationSec, output, musicVolume = 0.18 }) {
	const args = ["-i", narration];
	const filters = ["[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[voice][sc]"];
	const mixInputs = ["[voice]"];
	let idx = 1;
	if (music) {
		args.push("-stream_loop", "-1", "-i", music);
		const fadeOut = Math.max(0, durationSec - 2).toFixed(2);
		filters.push(
			`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${durationSec.toFixed(3)},asetpts=N/SR/TB,volume=${musicVolume},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=2[mus]`,
			"[mus][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]",
		);
		mixInputs.push("[ducked]");
		idx++;
	} else {
		filters.push("[sc]anullsink");
	}
	if (whoosh && whooshAtSec.length) {
		args.push("-i", whoosh);
		const labels = whooshAtSec.map((_, i) => `[w${i}]`);
		filters.push(`[${idx}:a]asplit=${whooshAtSec.length}${labels.join("")}`);
		whooshAtSec.forEach((t, i) => {
			const ms = Math.max(0, Math.round((t - 0.35) * 1000));
			filters.push(`[w${i}]adelay=${ms}|${ms}[wd${i}]`);
			mixInputs.push(`[wd${i}]`);
		});
	}
	filters.push(
		`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:normalize=0,alimiter=limit=0.95,atrim=0:${durationSec.toFixed(3)}[out]`,
	);
	await ffmpeg(
		[...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "aac", "-b:a", "192k", output],
		"ffmpeg mix audio",
	);
}

export async function muxFinal({ video, audio, output, srt, burnCaptions = false }) {
	const args = ["-i", video, "-i", audio];
	if (burnCaptions && srt) {
		const escaped = srt.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
		args.push(
			"-vf",
			`subtitles='${escaped}':force_style='Fontname=Arial,Fontsize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=40'`,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"20",
		);
	} else {
		args.push("-c:v", "copy");
	}
	args.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "copy", "-shortest", "-movflags", "+faststart", output);
	await ffmpeg(args, "ffmpeg mux final");
}

function clamp01(n) {
	const v = Number(n);
	return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}
