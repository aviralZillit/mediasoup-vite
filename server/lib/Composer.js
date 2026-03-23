const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('Composer');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

// Auto-detect a usable font on macOS / Linux.
const FONT_PATH = process.env.RECORDING_FONT_PATH ||
	_findFont();

function _findFont()
{
	const candidates = [
		'/System/Library/Fonts/Helvetica.ttc',          // macOS
		'/System/Library/Fonts/HelveticaNeue.ttc',      // macOS
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', // Debian/Ubuntu
		'/usr/share/fonts/TTF/DejaVuSans.ttf',          // Arch
		'/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf', // Fedora
	];

	for (const f of candidates)
	{
		if (fs.existsSync(f)) return f;
	}

	return ''; // Let FFmpeg use its built-in default.
}

// Output resolution.
const OUT_W = 1920;
const OUT_H = 1080;
const BG_COLOR = '0x1a1a1a'; // FFmpeg hex format for filters.

/**
 * Post-recording composition engine.
 *
 * Reads metadata + timeline from the Recording instance and produces
 * a professional 1920x1080 MP4 with:
 *   - Dynamic grid layout (adapts to participant count)
 *   - Screen share mode (75/25 split)
 *   - Name labels per tile
 *   - Meeting info overlay (room name, date, time UTC)
 *   - REC indicator
 *   - Synchronized audio/video streams
 */
class Composer
{
	/**
	 * @param {Object} params
	 * @param {String} params.roomDir   - Path to recordings/{roomId}/
	 * @param {String} params.rawDir    - Path to recordings/{roomId}/raw/
	 * @param {String} params.roomId
	 * @param {String} params.roomName
	 * @param {Number} params.globalStartTime
	 * @param {Map}    params.metadata  - Producer metadata map.
	 * @param {Array}  params.timeline  - Timeline events array.
	 */
	constructor({ roomDir, rawDir, roomId, roomName, globalStartTime, metadata, timeline })
	{
		this._roomDir = roomDir;
		this._rawDir = rawDir;
		this._roomId = roomId;
		this._roomName = roomName || roomId;
		this._globalStartTime = globalStartTime;
		this._metadata = metadata;  // Map<producerId, meta>
		this._timeline = timeline;  // Array of timeline events
	}

	/**
	 * Run the full composition pipeline.
	 *
	 * @returns {String|null} Path to the final MP4, or null on failure.
	 */
	async compose()
	{
		logger.info('========================================');
		logger.info('  COMPOSITION STARTED [room:%s]', this._roomId);
		logger.info('========================================');

		// 1) Probe all media files.
		logger.info('[1/5] Probing media files...');
		const streams = this._probeStreams();

		if (streams.length === 0)
		{
			logger.warn('No valid media files found — aborting composition');

			return null;
		}

		logger.info('[1/5] Found %d valid streams', streams.length);

		// 2) Calculate base offset — the earliest video frame in real time.
		//    We trim the composition by this amount so video appears
		//    immediately instead of showing grey background.
		const videoStreams = streams.filter((s) => s.kind === 'video');
		let baseOffset = 0;

		if (videoStreams.length > 0)
		{
			baseOffset = Math.min(
				...videoStreams.map((s) =>
					(s.streamStartOffset / 1000) + s.firstPts));

			logger.info('[1/5] Base offset (trim): %.3fs', baseOffset);
		}

		// Store baseOffset on the instance for use by other methods.
		this._baseOffset = baseOffset;

		// 3) Calculate total duration (after trimming).
		const totalDuration = this._calculateTotalDuration(streams);

		if (totalDuration < 2)
		{
			logger.warn('Recording too short (%ss) — skipping composition',
				totalDuration.toFixed(1));

			return null;
		}

		logger.info('[2/5] Total duration: %ss', totalDuration.toFixed(1));

		// 4) Build timeline segments.
		logger.info('[3/5] Building timeline segments...');
		const segments = this._buildSegments(streams, totalDuration);

		logger.info('[3/5] Built %d layout segments', segments.length);

		// 5) Generate the FFmpeg filtergraph.
		logger.info('[4/5] Generating filtergraph...');
		const { filtergraph, inputArgs, audioStreams } =
			this._buildFiltergraph(streams, segments, totalDuration);

		const filtergraphPath = path.join(this._rawDir, 'filtergraph.txt');

		fs.writeFileSync(filtergraphPath, filtergraph);

		logger.info('[4/5] Filtergraph written (%d bytes)', filtergraph.length);
		logger.debug('Filtergraph:\n%s', filtergraph);

		// 5) Run FFmpeg.
		const startDate = new Date(this._globalStartTime);
		const utcTag = this._utcTag(startDate);
		const outputFile = path.join(
			this._roomDir,
			`Room-${this._roomId}_${utcTag}_UTC.mp4`);

		logger.info('[5/5] Running FFmpeg composition → %s', outputFile);

		const args = [
			...inputArgs,
			'-filter_complex_script', filtergraphPath,
			'-map', '[vout]',
		];

		if (audioStreams.length > 0)
		{
			args.push('-map', '[aout]');
		}

		args.push(
			'-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
			'-pix_fmt', 'yuv420p',
			'-threads', '0',
			'-c:a', 'aac', '-b:a', '128k',
			'-shortest',                     // End when shortest stream (video canvas) ends — prevents black screen with trailing audio
			'-movflags', '+faststart',
			'-y', outputFile);

		try
		{
			await this._runFFmpeg(args);
		}
		catch (error)
		{
			logger.error('[5/5] FFmpeg composition FAILED: %o', error);

			return null;
		}

		// 6) Verify output.
		try
		{
			const stat = fs.statSync(outputFile);

			logger.info('========================================');
			logger.info('  COMPOSITION COMPLETE');
			logger.info('  Room: %s', this._roomId);
			logger.info('  Size: %sMB', (stat.size / (1024 * 1024)).toFixed(1));
			logger.info('  Output: %s', outputFile);
			logger.info('========================================');

			return outputFile;
		}
		catch (e)
		{
			logger.error('Output file missing after composition');

			return null;
		}
	}

	// -------------------------------------------------------------------------
	// Stream probing
	// -------------------------------------------------------------------------

	_probeStreams()
	{
		const streams = [];

		for (const [ producerId, meta ] of this._metadata)
		{
			const filePath = meta.filePath;

			if (!filePath || !fs.existsSync(filePath))
			{
				logger.warn('  Skip missing file [producerId:%s, path:%s]',
					producerId, filePath);
				continue;
			}

			const stat = fs.statSync(filePath);

			if (stat.size === 0)
			{
				logger.warn('  Skip empty file [producerId:%s]', producerId);
				continue;
			}

			// Probe duration and start_time with ffprobe.
			let duration = 0;
			let startTime = 0;

			try
			{
				const out = execSync(
					`"${FFPROBE_PATH}" -v quiet -print_format json -show_format "${filePath}"`,
					{ timeout: 10000, encoding: 'utf8' });

				const info = JSON.parse(out);

				duration = parseFloat(info.format.duration) || 0;
				startTime = parseFloat(info.format.start_time) || 0;
			}
			catch (e)
			{
				logger.warn('  ffprobe failed for %s, using file size estimate', filePath);
				// Rough estimate: assume 500kbps.
				duration = (stat.size * 8) / 500000;
			}

			// Also probe the actual first PTS — this is the real start time
			// of media content. For video, RTP may buffer for seconds before
			// delivering the first keyframe, so firstPts can be much larger
			// than start_time.
			let firstPts = startTime;

			try
			{
				const ptsOut = execSync(
					`"${FFPROBE_PATH}" -v quiet -print_format json ` +
					`-show_entries packet=pts_time -read_intervals "%+#1" "${filePath}"`,
					{ timeout: 10000, encoding: 'utf8' });

				const ptsInfo = JSON.parse(ptsOut);
				const packets = ptsInfo.packets || [];

				if (packets.length > 0)
				{
					firstPts = parseFloat(packets[0].pts_time) || startTime;
				}
			}
			catch (e)
			{
				// Fall back to start_time.
			}

			if (duration < 0.5)
			{
				logger.warn(
					'  Skip very short file [producerId:%s, duration:%ss]',
					producerId, duration.toFixed(1));
				continue;
			}

			streams.push({
				producerId,
				...meta,
				duration,
				startTime,
				firstPts,
				fileSize : stat.size,
			});

			logger.info(
				'  ✓ %s | %s | %s | %ss | firstPts=%.3fs | %sMB',
				meta.displayName,
				meta.kind,
				meta.share ? 'screen' : 'camera',
				duration.toFixed(1),
				firstPts,
				(stat.size / (1024 * 1024)).toFixed(1));
		}

		return streams;
	}

	// -------------------------------------------------------------------------
	// Timeline segments
	// -------------------------------------------------------------------------

	_buildSegments(streams, totalDuration)
	{
		const base = this._baseOffset || 0;

		// Collect all layout-changing event times from the timeline.
		const events = [ ...this._timeline ].sort((a, b) => a.t - b.t);

		// Build a set of time boundaries (all relative to baseOffset-trimmed timeline).
		const boundaries = new Set([ 0 ]);

		for (const ev of events)
		{
			const t = (ev.t / 1000) - base;

			if (t > 0) boundaries.add(t);
		}

		// Also add real stream start times as boundaries.
		for (const stream of streams)
		{
			if (stream.kind === 'video')
			{
				const realStart = (stream.streamStartOffset / 1000) + stream.firstPts - base;

				if (realStart > 0) boundaries.add(realStart);
			}
		}

		boundaries.add(totalDuration);

		const sortedBounds = [ ...boundaries ].sort((a, b) => a - b);

		// For each segment, determine which video/audio/screen streams are active.
		const segments = [];

		for (let i = 0; i < sortedBounds.length - 1; i++)
		{
			const segStart = sortedBounds[i];
			const segEnd = sortedBounds[i + 1];

			if (segEnd - segStart < 0.1) continue;

			const activeVideos = [];
			const activeAudios = [];
			let screenShare = null;

			for (const stream of streams)
			{
				const realStart = (stream.streamStartOffset / 1000) + stream.firstPts - base;
				const contentDuration = stream.duration - stream.firstPts;
				const streamStart = realStart;
				const streamEnd = realStart + contentDuration;

				if (streamStart < segEnd && streamEnd > segStart)
				{
					if (stream.kind === 'video')
					{
						if (stream.share)
							screenShare = stream;
						else
							activeVideos.push(stream);
					}
					else if (stream.kind === 'audio')
					{
						activeAudios.push(stream);
					}
				}
			}

			segments.push({
				start   : segStart,
				end     : segEnd,
				videos  : activeVideos,
				audios  : activeAudios,
				screenShare,
			});

			logger.debug(
				'  Segment [%s–%s]: %d videos, %d audios, screen:%s',
				segStart.toFixed(1), segEnd.toFixed(1),
				activeVideos.length, activeAudios.length,
				screenShare ? 'yes' : 'no');
		}

		return segments;
	}

	_calculateTotalDuration(streams)
	{
		let max = 0;
		const base = this._baseOffset || 0;

		for (const s of streams)
		{
			const realStart = (s.streamStartOffset / 1000) + s.firstPts;
			const contentDuration = s.duration - s.firstPts;
			// Subtract baseOffset so composition starts at first video frame.
			const end = (realStart - base) + contentDuration;

			if (end > max) max = end;
		}

		return max;
	}

	// -------------------------------------------------------------------------
	// Filtergraph generation
	// -------------------------------------------------------------------------

	_buildFiltergraph(streams, segments, totalDuration)
	{
		const lines = [];
		const inputArgs = [];
		const audioStreams = [];

		// Separate video and audio streams.
		const videoList = streams.filter((s) => s.kind === 'video');
		const audioList = streams.filter((s) => s.kind === 'audio');

		// Build input args: videos first, then audios.
		let inputIdx = 0;
		const streamInputMap = new Map(); // producerId -> input index

		for (const vs of videoList)
		{
			inputArgs.push('-i', vs.filePath);
			streamInputMap.set(vs.producerId, inputIdx);
			inputIdx++;
		}

		for (const as of audioList)
		{
			inputArgs.push('-i', as.filePath);
			streamInputMap.set(as.producerId, inputIdx);
			audioStreams.push(as);
			inputIdx++;
		}

		// =====================================================================
		// Video filtergraph — SIMPLIFIED (no splits)
		//
		// Instead of creating N splits per video for N segments, we scale
		// each video ONCE to the max tile size and overlay it ONCE using
		// FFmpeg expression-based x/y positioning that changes per segment.
		// This reduces a 196-line filtergraph to ~30 lines.
		// =====================================================================

		// Background canvas.
		lines.push(
			`color=c=${BG_COLOR}:s=${OUT_W}x${OUT_H}:d=${totalDuration.toFixed(3)}:r=30[bg]`);

		const base = this._baseOffset || 0;

		// ---- Scale each video input once ----
		for (const vs of videoList)
		{
			const idx = streamInputMap.get(vs.producerId);
			const realOffset = Math.max(0,
				(vs.streamStartOffset / 1000) + vs.firstPts - base);

			logger.info(
				'  Video sync [%s]: streamStartOffset=%dms, firstPts=%.3fs, baseOffset=%.3fs, tpad=%.3fs',
				vs.displayName, vs.streamStartOffset, vs.firstPts, base, realOffset);

			let chain = `[${idx}:v]setpts=PTS-STARTPTS`;

			if (realOffset > 0.05)
			{
				chain += `,tpad=start_duration=${realOffset.toFixed(3)}:start_mode=clone`;
			}

			// Scale to max possible tile size (full screen), keep aspect ratio.
			// The overlay position will handle actual placement.
			chain += `,scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease` +
				`,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=${BG_COLOR}`;

			lines.push(`${chain}[v_${vs.producerId}]`);
		}

		// ---- Build per-video overlay with expression-based positioning ----
		// For each video, find all segments where it appears and build
		// an enable expression + positional expression.
		let prevLabel = 'bg';
		let overlayCount = 0;

		const fontArg = FONT_PATH
			? `fontfile='${FONT_PATH}'\\:`
			: '';

		for (const vs of videoList)
		{
			// Collect all tiles for this video across all segments.
			const placements = [];

			for (const seg of segments)
			{
				const tiles = this._calculateLayout(seg);
				const tile = tiles.find((t) => t.producerId === vs.producerId);

				if (tile)
				{
					placements.push({
						start : seg.start,
						end   : seg.end,
						x     : tile.x,
						y     : tile.y,
						w     : tile.w,
						h     : tile.h,
						displayName : tile.displayName,
					});
				}
			}

			if (placements.length === 0) continue;

			// Merge adjacent segments with same position/size.
			const merged = [ placements[0] ];

			for (let i = 1; i < placements.length; i++)
			{
				const prev = merged[merged.length - 1];
				const curr = placements[i];

				if (prev.x === curr.x && prev.y === curr.y &&
					prev.w === curr.w && prev.h === curr.h &&
					Math.abs(prev.end - curr.start) < 0.2)
				{
					prev.end = curr.end;
				}
				else
				{
					merged.push(curr);
				}
			}

			// Build enable expression: enable only when this video is visible.
			const enableParts = merged.map((p) =>
				`between(t\\,${p.start.toFixed(3)}\\,${p.end.toFixed(3)})`);
			const enableExpr = enableParts.join('+');

			// Build x/y/w/h expressions for dynamic positioning.
			// Use if() chains: if(between(t,s1,e1), x1, if(between(t,s2,e2), x2, -9999))
			const buildPosExpr = (prop) =>
			{
				let expr = String(merged[merged.length - 1][prop]);

				for (let i = merged.length - 2; i >= 0; i--)
				{
					const p = merged[i];

					expr = `if(between(t\\,${p.start.toFixed(3)}\\,${p.end.toFixed(3)})\\,${p[prop]}\\,${expr})`;
				}

				if (merged.length > 1)
				{
					return expr;
				}

				return String(merged[0][prop]);
			};

			const xExpr = buildPosExpr('x');
			const yExpr = buildPosExpr('y');

			// Scale video to the tile size. Since tiles may change size
			// across segments, use the largest tile dimensions.
			const maxW = Math.max(...merged.map((p) => p.w));
			const maxH = Math.max(...merged.map((p) => p.h));

			const scaleLabel = `sc_${overlayCount}`;
			const ovLabel = `ov_${overlayCount}`;

			// Re-scale from full-frame to max tile size.
			lines.push(
				`[v_${vs.producerId}]scale=${maxW}:${maxH}:` +
				`force_original_aspect_ratio=decrease,` +
				`pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2:` +
				`color=${BG_COLOR}[${scaleLabel}]`);

			// Overlay with dynamic position and enable.
			lines.push(
				`[${prevLabel}][${scaleLabel}]overlay=` +
				`x='${xExpr}':y='${yExpr}':` +
				`enable='${enableExpr}'` +
				`[${ovLabel}]`);

			prevLabel = ovLabel;
			overlayCount++;

			// Name label — use the last known displayName.
			// Position below the tile using the same enable/position logic.
			const nameExpr = merged.length === 1
				? `${merged[0].x + 16}`
				: buildPosExpr('x');

			const nameYExpr = merged.length === 1
				? `${merged[0].y + merged[0].h - 48}`
				: merged.map((p) => ({
					...p,
					x : p.x + 16,
					y : p.y + p.h - 48,
				})).reduce((expr, p, i, arr) =>
				{
					if (i === arr.length - 1) return String(p.y);

					return `if(between(t\\,${p.start.toFixed(3)}\\,${p.end.toFixed(3)})\\,${p.y}\\,${expr})`;
				}, '');

			const escaped = this._escapeDrawtext(
				merged[merged.length - 1].displayName);

			const nlLabel = `nl_${overlayCount}`;

			lines.push(
				`[${prevLabel}]drawtext=${fontArg}` +
				`text='${escaped}':` +
				`fontsize=28:fontcolor=white:` +
				`x='${nameExpr.toString().includes('if(') ? nameExpr : merged[0].x + 16}':` +
				`y='${typeof nameYExpr === 'string' && nameYExpr.includes('if(') ? nameYExpr : merged[0].y + merged[0].h - 48}':` +
				`box=1:boxcolor=black@0.6:boxborderw=8:` +
				`enable='${enableExpr}'` +
				`[${nlLabel}]`);

			prevLabel = nlLabel;
			overlayCount++;
		}

		// ---- Meeting info overlay (top-left, always visible) ----
		const startDate = new Date(this._globalStartTime);
		const dateStr = startDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
		const roomText = this._escapeDrawtext(`Room: ${this._roomName}  |  ${dateStr}`);

		const infoLbl = `info_${overlayCount}`;

		lines.push(
			`[${prevLabel}]drawtext=${fontArg}` +
			`text='${roomText}':` +
			`fontsize=22:fontcolor=white@0.85:x=24:y=24:` +
			`box=1:boxcolor=black@0.5:boxborderw=8` +
			`[${infoLbl}]`);

		prevLabel = infoLbl;
		overlayCount++;

		// ---- REC indicator (top-right, always visible) ----
		const recLbl = `rec_${overlayCount}`;

		lines.push(
			`[${prevLabel}]drawtext=${fontArg}` +
			`text='● REC':` +
			`fontsize=24:fontcolor=red:x=${OUT_W - 100}:y=24:` +
			`box=1:boxcolor=black@0.5:boxborderw=8` +
			`[${recLbl}]`);

		prevLabel = recLbl;
		overlayCount++;

		// ---- Elapsed timer (next to REC) ----
		const timerLbl = `timer_${overlayCount}`;

		lines.push(
			`[${prevLabel}]drawtext=${fontArg}` +
			`text='%{pts\\:hms}':` +
			`fontsize=20:fontcolor=white@0.7:x=${OUT_W - 100}:y=54:` +
			`box=1:boxcolor=black@0.4:boxborderw=6` +
			`[${timerLbl}]`);

		prevLabel = timerLbl;
		overlayCount++;

		// Final video output.
		lines.push(`[${prevLabel}]null[vout]`);

		// =====================================================================
		// Audio filtergraph
		// =====================================================================

		if (audioList.length > 0)
		{
			const baseMs = Math.round(base * 1000);

			for (const as of audioList)
			{
				const idx = streamInputMap.get(as.producerId);
				// Subtract baseOffset (in ms) so audio aligns with trimmed video.
				const realOffsetMs = Math.max(0, Math.round(
					as.streamStartOffset + (as.firstPts * 1000) - baseMs));

				// If this audio started BEFORE baseOffset, we need to skip
				// the first (baseMs - streamStartOffset) ms of audio.
				const rawOffsetMs = Math.round(
					as.streamStartOffset + (as.firstPts * 1000));
				const trimSec = rawOffsetMs < baseMs
					? ((baseMs - rawOffsetMs) / 1000).toFixed(3)
					: null;

				logger.info(
					'  Audio sync [%s]: streamStartOffset=%dms, firstPts=%.3fs, baseMs=%d, adelay=%d, trim=%s',
					as.displayName, as.streamStartOffset, as.firstPts,
					baseMs, realOffsetMs, trimSec || 'none');

				let audioChain = `[${idx}:a]asetpts=PTS-STARTPTS`;

				// Trim audio that started before baseOffset.
				if (trimSec)
				{
					audioChain += `,atrim=start=${trimSec},asetpts=PTS-STARTPTS`;
				}

				if (realOffsetMs > 50)
				{
					audioChain += `,adelay=${realOffsetMs}|${realOffsetMs}`;
				}

				lines.push(`${audioChain}[a_pad_${idx}]`);
			}

			if (audioList.length === 1)
			{
				const idx = streamInputMap.get(audioList[0].producerId);

				lines.push(`[a_pad_${idx}]anull[aout]`);
			}
			else
			{
				const mixInputs = audioList
					.map((as) => `[a_pad_${streamInputMap.get(as.producerId)}]`)
					.join('');

				// amix normalizes volume (divides by N inputs). Add volume
				// filter to restore full level so audio doesn't sound quiet.
				lines.push(
					`${mixInputs}amix=inputs=${audioList.length}:` +
					`duration=longest:dropout_transition=2,` +
					`volume=${audioList.length}[aout]`);
			}
		}

		// Join lines with FFmpeg filter_complex separator.
		const filtergraph = lines.join(';\n');

		return { filtergraph, inputArgs, audioStreams };
	}

	// -------------------------------------------------------------------------
	// Layout calculator
	// -------------------------------------------------------------------------

	_calculateLayout(segment)
	{
		const tiles = [];
		const { videos, screenShare } = segment;

		if (screenShare)
		{
			// Screen share mode: 75% left for screen, 25% right for cameras.
			const shareW = Math.round(OUT_W * 0.75);
			const shareH = OUT_H;
			const camW = OUT_W - shareW;

			tiles.push({
				producerId  : screenShare.producerId,
				displayName : `${screenShare.displayName} (Screen)`,
				x           : 0,
				y           : 0,
				w           : shareW,
				h           : shareH,
			});

			const n = videos.length;

			if (n > 0)
			{
				const camH = Math.floor(OUT_H / n);

				for (let i = 0; i < n; i++)
				{
					tiles.push({
						producerId  : videos[i].producerId,
						displayName : videos[i].displayName,
						x           : shareW,
						y           : i * camH,
						w           : camW,
						h           : camH,
					});
				}
			}
		}
		else
		{
			const n = videos.length;

			if (n === 0) return tiles;

			let cols, rows;

			if (n === 1)      { cols = 1; rows = 1; }
			else if (n === 2) { cols = 2; rows = 1; }
			else if (n <= 4)  { cols = 2; rows = 2; }
			else if (n <= 6)  { cols = 3; rows = 2; }
			else if (n <= 9)  { cols = 3; rows = 3; }
			else              { cols = 4; rows = Math.ceil(n / 4); }

			const tileW = Math.floor(OUT_W / cols);
			const tileH = Math.floor(OUT_H / rows);

			// Center the grid.
			const gridW = cols * tileW;
			const gridH = rows * tileH;
			const offsetX = Math.floor((OUT_W - gridW) / 2);
			const offsetY = Math.floor((OUT_H - gridH) / 2);

			for (let i = 0; i < n; i++)
			{
				const col = i % cols;
				const row = Math.floor(i / cols);

				tiles.push({
					producerId  : videos[i].producerId,
					displayName : videos[i].displayName,
					x           : offsetX + col * tileW,
					y           : offsetY + row * tileH,
					w           : tileW,
					h           : tileH,
				});
			}
		}

		return tiles;
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	_escapeDrawtext(text)
	{
		// FFmpeg drawtext escaping: ' : \ and special chars.
		return (text || '')
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "'\\\\\\''")
			.replace(/:/g, '\\:')
			.replace(/%/g, '%%')
			.replace(/\[/g, '\\[')
			.replace(/\]/g, '\\]');
	}

	_utcTag(date)
	{
		const d = date || new Date();
		const pad = (n) => String(n).padStart(2, '0');

		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_` +
			`${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
	}

	_runFFmpeg(args)
	{
		return new Promise((resolve, reject) =>
		{
			logger.info('FFmpeg args: %s', args.join(' ').slice(0, 600));

			const proc = spawn(FFMPEG_PATH, args, { stdio: [ 'pipe', 'pipe', 'pipe' ] });

			let stderr = '';
			let lastProgress = '';

			proc.stderr.on('data', (d) =>
			{
				const chunk = d.toString();

				stderr += chunk;

				// Log progress lines.
				const match = chunk.match(/time=(\S+)/);

				if (match && match[1] !== lastProgress)
				{
					lastProgress = match[1];
					logger.info('  Progress: time=%s', lastProgress);
				}

				if (stderr.length > 50000)
					stderr = stderr.slice(-25000);
			});

			proc.on('error', (error) =>
			{
				reject(error);
			});

			proc.on('exit', (code) =>
			{
				if (code === 0)
				{
					logger.info('  FFmpeg composition finished successfully');
					resolve();
				}
				else
				{
					logger.error('  FFmpeg failed [code:%d]', code);
					logger.error('  Last stderr:\n%s', stderr.slice(-1000));
					reject(new Error(`FFmpeg exited with code ${code}`));
				}
			});
		});
	}
}

module.exports = Composer;
