import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CueMotionText } from '../src/motion/CueMotionText';
import { compileDocument } from '../src/domain/model/document.mjs';
import { createPlayer } from '../src/runtime/player.mjs';
import { createRecordingMotionSample } from './fixtures/recording-motion-project.mjs';
import { MOTION_PRESETS } from '../src/motion/effects.mjs';
import '../src/app.css';

const sample = createRecordingMotionSample();
const plan = compileDocument(sample.chapters[0].document);
function Demo() {
  const [state, setState] = useState<any>({ status: 'stopped', elapsedMs: 0, index: 1 });
  const [selected, setSelected] = useState(1);
  const [customText, setCustomText] = useState('');
  const player = useRef<any>(null);
  useEffect(() => {
    player.current = createPlayer({ getPlan: () => plan, onChange: setState, onEnter: () => {}, onPauseMedia: () => {}, onResumeMedia: () => {}, onSeekMedia: () => {}, onStopMedia: () => {} });
    (window as any).motionDemo = { player: player.current, plan, setCustomText };
    return () => player.current.stop();
  }, []);
  const index = state.status === 'stopped' ? selected : state.index;
  const cue = { ...plan[index], text: customText || plan[index].text, children: [{ type: 'text', text: customText || plan[index].text }] };
  const play = () => state.status === 'playing' ? player.current.pause() : state.status === 'paused' ? player.current.resume() : player.current.playFrom(selected, 'click');
  return <main style={{ maxWidth: 1100, margin: '32px auto', padding: 24 }}>
    <h1>录屏动效 · 工作台试作</h1><p>复用工作台的文字组件和播放器。两项轻量接入，先把一句剧情演清楚。</p>
    <label>演出句 <select aria-label="演出句" value={index} onChange={(event) => { player.current.stop(); setSelected(Number(event.target.value)); setCustomText(''); }}>{plan.map((item: any, at: number) => <option key={item.id} value={at}>{at + 1}. {item.text.replace(/\n/g, ' / ')} · {MOTION_PRESETS.find((preset) => preset.id === item.settings.motion)?.name}</option>)}</select></label>
    <div id="demo-stage" style={{ position: 'relative', containerType: 'inline-size', aspectRatio: '16 / 9', marginTop: 20, background: '#131922', border: '1px solid #354252', overflow: 'hidden' }}>
      <div className="stage-cue free-cue" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: '88%' }}><span className="cue-text" style={{ color: cue.settings.color, fontSize: '3.54cqi' }}><CueMotionText cue={cue} elapsedMs={state.elapsedMs} staticPreview={state.status === 'stopped'} /></span></div>
    </div>
    <div className="transport-bar" style={{ margin: '16px 0', width: '100%' }}><div className="transport-buttons"><button id="demo-play" onClick={play}>{state.status === 'playing' ? '暂停' : state.status === 'paused' ? '继续' : '播放'}</button><button id="demo-replay" onClick={() => player.current.playFrom(selected, 'click')}>重播</button><button id="demo-stop" onClick={() => player.current.stop()}>停止</button></div><input aria-label="时间定位" className="seek-range" type="range" min={0} max={cue.settings.durationMs} value={state.elapsedMs} onChange={(event) => { if (state.status === 'stopped') { player.current.playFrom(selected, 'click'); player.current.pause(); } player.current.seek(Number(event.target.value) / cue.settings.durationMs); }} /><output>{Math.round(state.elapsedMs)} ms</output></div>
    <label>替换文字（用来观察排版，时长沿用原样例）<textarea aria-label="替换文字" rows={2} style={{ display: 'block', width: '100%', marginTop: 8 }} value={customText} placeholder={plan[index].text} onChange={(event) => setCustomText(event.target.value)} /></label>
    <p>RP-A2：固定字槽、每列八字；RP-F1：青紫残影分离并收敛。不含音乐，不声称对齐原片。</p>
    <p>在工作台 F 区选择同名动效，可调整参数和延长建议时长。<a href="./使用说明.md">使用说明与可复制提示词</a></p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Demo />);
