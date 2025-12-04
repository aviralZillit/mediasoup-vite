# Recording Modes

The server supports two recording modes, controlled by the `RECORDING_MODE` environment variable:

## 1. Live Composition Mode (`mode: 'live'`)

**How it works:**
- Uses GStreamer compositor to mix all streams in real-time
- Creates a single output video file as recording happens
- Layout changes happen dynamically as people join/leave

**Pros:**
- No post-processing needed - video ready immediately when recording stops
- Lower storage usage (only one file)
- Real-time layout transitions

**Cons:**
- Higher CPU usage during recording
- Layout is fixed once recording starts
- Cannot adjust layout after recording

**Use when:**
- You need immediate playback after recording
- Server has good CPU resources
- Storage is limited

## 2. Post-Processing Mode (`mode: 'post-processing'`)

**How it works:**
- Records each participant's audio/video as separate files
- After recording stops, uses FFmpeg to compose them into final video
- Individual files stored in `recordings/{roomId}/raw/{timestamp}/`

**Pros:**
- Lower CPU usage during recording
- Can adjust layout/composition after recording
- Keep raw individual streams for backup/editing

**Cons:**
- Delay after recording stops (composition takes time)
- Higher storage usage (raw + final files)
- More complex

**Use when:**
- You need flexibility to recompose later
- CPU resources limited during call
- Want to keep individual streams

## Configuration

In `config.js`:
```javascript
recording: {
    mode: 'post-processing', // or 'live'
    // ... other settings
}
```

Or via environment variable:
```bash
RECORDING_MODE=live npm start
# or
RECORDING_MODE=post-processing npm start
```

## Current Implementation Status

- ✅ Live mode: Working (GStreamer compositor)
- ✅ Post-processing mode: Working (simplified static layout)
- ⚠️ Dynamic transitions in post-processing: Complex, currently uses static layout
