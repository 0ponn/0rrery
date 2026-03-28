import { useState, useEffect, useCallback } from 'react';

export default function PlaybackView({ onLoadSession, C }) {
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [playbackState, setPlaybackState] = useState('stopped');
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [intervalId, setIntervalId] = useState(null);

  useEffect(() => {
    loadSessionList();
  }, []);

  const loadSessionList = async () => {
    try {
      const response = await fetch('http://localhost:4243/sessions');
      const data = await response.json();
      setSessions(data);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  };

  const loadSession = async (sessionId) => {
    try {
      const response = await fetch(`http://localhost:4243/sessions/${sessionId}`);
      const session = await response.json();
      setSelectedSession(session);
      setPlaybackIndex(0);
      setPlaybackState('stopped');

      if (onLoadSession) {
        onLoadSession(session);
      }
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  };

  const play = useCallback(() => {
    if (!selectedSession || playbackIndex >= selectedSession.events.length) {
      setPlaybackState('stopped');
      return;
    }

    setPlaybackState('playing');

    const interval = 100 / playbackSpeed;
    const id = setInterval(() => {
      setPlaybackIndex(idx => {
        if (idx >= selectedSession.events.length) {
          setPlaybackState('stopped');
          clearInterval(id);
          return idx;
        }

        const event = selectedSession.events[idx];
        if (onLoadSession) {
          onLoadSession({ ...selectedSession, events: selectedSession.events.slice(0, idx + 1) });
        }
        return idx + 1;
      });
    }, interval);

    setIntervalId(id);
  }, [selectedSession, playbackIndex, playbackSpeed, onLoadSession]);

  const pause = () => {
    if (intervalId) {
      clearInterval(intervalId);
      setIntervalId(null);
    }
    setPlaybackState('paused');
  };

  const reset = () => {
    if (intervalId) {
      clearInterval(intervalId);
      setIntervalId(null);
    }
    setPlaybackState('stopped');
    setPlaybackIndex(0);
    if (selectedSession && onLoadSession) {
      onLoadSession({ ...selectedSession, events: [] });
    }
  };

  const seekTo = (percent) => {
    if (!selectedSession) return;
    const newIndex = Math.floor(percent * selectedSession.events.length);
    setPlaybackIndex(newIndex);
    if (onLoadSession) {
      onLoadSession({ ...selectedSession, events: selectedSession.events.slice(0, newIndex) });
    }
  };

  useEffect(() => {
    if (playbackState === 'playing') {
      play();
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [playbackState, play, intervalId]);

  const progress = selectedSession ? (playbackIndex / selectedSession.events.length) * 100 : 0;

  return (
    <div style={{ height:'100%', display:'flex', flexDirection:'column', gap:20, padding:20 }}>
      {/* Session List */}
      <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, padding:20 }}>
        <div style={{ fontSize:16, fontWeight:600, color:C.white, marginBottom:12 }}>Recorded Sessions</div>
        <div style={{ display:'grid', gap:8 }}>
          {sessions.length === 0 && (
            <div style={{ color:C.dimText, fontSize:12, padding:20, textAlign:'center' }}>
              No recorded sessions found. Run a workflow to create one.
            </div>
          )}
          {sessions.map(s => (
            <div
              key={s.sessionId}
              onClick={() => loadSession(s.sessionId)}
              style={{
                background: selectedSession?.sessionId === s.sessionId ? C.bg : 'transparent',
                border: `1px solid ${selectedSession?.sessionId === s.sessionId ? C.teal : C.border}`,
                borderRadius:6,
                padding:'12px 16px',
                cursor:'pointer',
                transition:'all 0.2s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = C.bg}
              onMouseLeave={e => {
                if (selectedSession?.sessionId !== s.sessionId) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
            >
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ color:C.white, fontSize:13, fontWeight:500, fontFamily:'monospace' }}>
                    {s.sessionId}
                  </div>
                  <div style={{ color:C.dimText, fontSize:11, marginTop:2 }}>
                    {new Date(s.startTime).toLocaleString()}
                  </div>
                </div>
                <div style={{ display:'flex', gap:16, color:C.dimText, fontSize:11 }}>
                  <span>{s.eventCount} events</span>
                  <span>{(s.duration / 1000).toFixed(1)}s</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Playback Controls */}
      {selectedSession && (
        <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:600, color:C.white, marginBottom:12 }}>Playback Controls</div>

          <div style={{ display:'flex', gap:12, marginBottom:16, alignItems:'center' }}>
            <button
              onClick={() => playbackState === 'playing' ? pause() : play()}
              disabled={playbackIndex >= selectedSession.events.length && playbackState === 'stopped'}
              style={{
                padding:'10px 20px',
                background: playbackState === 'playing' ? C.orange : C.teal,
                border:'none',
                color:C.bg,
                fontSize:12,
                borderRadius:6,
                cursor:'pointer',
                fontWeight:600,
                opacity: playbackIndex >= selectedSession.events.length && playbackState === 'stopped' ? 0.5 : 1,
              }}
            >
              {playbackState === 'playing' ? '⏸ Pause' : '▶ Play'}
            </button>

            <button
              onClick={reset}
              style={{
                padding:'10px 20px',
                background:'transparent',
                border:`1px solid ${C.border}`,
                color:C.white,
                fontSize:12,
                borderRadius:6,
                cursor:'pointer',
              }}
            >
              ⏹ Reset
            </button>

            <select
              value={playbackSpeed}
              onChange={e => setPlaybackSpeed(parseFloat(e.target.value))}
              style={{
                padding:'10px 12px',
                background:C.bg,
                border:`1px solid ${C.border}`,
                color:C.white,
                fontSize:12,
                borderRadius:6,
                outline:'none',
                cursor:'pointer',
              }}
            >
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="5">5x</option>
              <option value="10">10x</option>
            </select>

            <div style={{ color:C.dimText, fontSize:12, fontFamily:'monospace', marginLeft:'auto' }}>
              {playbackIndex} / {selectedSession.events.length}
            </div>
          </div>

          {/* Progress Bar */}
          <div
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              seekTo(percent);
            }}
            style={{
              width:'100%',
              height:8,
              background:C.bg,
              borderRadius:4,
              overflow:'hidden',
              cursor:'pointer',
            }}
          >
            <div style={{
              height:'100%',
              width: `${progress}%`,
              background: `linear-gradient(90deg, ${C.teal}, ${C.blue})`,
              transition:'width 0.1s linear',
            }} />
          </div>
        </div>
      )}

      {/* Session Stats */}
      {selectedSession && (
        <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:600, color:C.white, marginBottom:12 }}>Session Statistics</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:12 }}>
            <StatCard label="Total Events" value={selectedSession.events.length} color={C.teal} />
            <StatCard label="Duration" value={`${(selectedSession.metadata.duration / 1000).toFixed(1)}s`} color={C.blue} />
            <StatCard
              label="Agent Spawns"
              value={selectedSession.events.filter(e => e.type === 'agent_spawn').length}
              color={C.purple}
            />
            <StatCard
              label="IPC Messages"
              value={selectedSession.events.filter(e => e.type === 'ipc_message').length}
              color={C.magenta}
            />
            <StatCard
              label="MCP Calls"
              value={selectedSession.events.filter(e => e.type === 'mcp_call').length}
              color={C.green}
            />
            <StatCard
              label="Model Calls"
              value={selectedSession.events.filter(e => e.type === 'model_call').length}
              color={C.orange}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:6, padding:12 }}>
      <div style={{ color:'#808080', fontSize:10, marginBottom:4 }}>{label}</div>
      <div style={{ color, fontSize:20, fontWeight:600 }}>{value}</div>
    </div>
  );
}
