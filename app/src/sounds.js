// Synthesized notification sounds using Web Audio API.
// No external sound files needed.

let _audioCtx = null;

function _getCtx() {
	if (!_audioCtx) {
		_audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	}

	return _audioCtx;
}

/**
 * Short rising chime — played when a peer joins.
 * Two-tone: C5 → E5, soft sine wave.
 */
export function playJoinSound() {
	try {
		const ctx = _getCtx();
		const now = ctx.currentTime;

		const gain = ctx.createGain();

		gain.connect(ctx.destination);
		gain.gain.setValueAtTime(0.15, now);
		gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

		const osc1 = ctx.createOscillator();

		osc1.type = 'sine';
		osc1.frequency.setValueAtTime(523.25, now); // C5
		osc1.connect(gain);
		osc1.start(now);
		osc1.stop(now + 0.15);

		const osc2 = ctx.createOscillator();

		osc2.type = 'sine';
		osc2.frequency.setValueAtTime(659.25, now + 0.12); // E5
		osc2.connect(gain);
		osc2.start(now + 0.12);
		osc2.stop(now + 0.35);
	}
	catch (e) {
		// Audio context not available — silently ignore.
	}
}

/**
 * Short falling tone — played when a peer leaves.
 * Two-tone: E5 → C5, soft sine wave.
 */
export function playLeaveSound() {
	try {
		const ctx = _getCtx();
		const now = ctx.currentTime;

		const gain = ctx.createGain();

		gain.connect(ctx.destination);
		gain.gain.setValueAtTime(0.12, now);
		gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

		const osc1 = ctx.createOscillator();

		osc1.type = 'sine';
		osc1.frequency.setValueAtTime(659.25, now); // E5
		osc1.connect(gain);
		osc1.start(now);
		osc1.stop(now + 0.15);

		const osc2 = ctx.createOscillator();

		osc2.type = 'sine';
		osc2.frequency.setValueAtTime(523.25, now + 0.12); // C5
		osc2.connect(gain);
		osc2.start(now + 0.12);
		osc2.stop(now + 0.35);
	}
	catch (e) {
		// Audio context not available — silently ignore.
	}
}

/**
 * Soft pop — played for chat messages.
 */
export function playMessageSound() {
	try {
		const ctx = _getCtx();
		const now = ctx.currentTime;

		const gain = ctx.createGain();

		gain.connect(ctx.destination);
		gain.gain.setValueAtTime(0.1, now);
		gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

		const osc = ctx.createOscillator();

		osc.type = 'sine';
		osc.frequency.setValueAtTime(880, now); // A5
		osc.connect(gain);
		osc.start(now);
		osc.stop(now + 0.1);
	}
	catch (e) {
		// Audio context not available — silently ignore.
	}
}
