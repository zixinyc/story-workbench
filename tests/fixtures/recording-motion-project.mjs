import { createBlankProject } from '../../src/domain/model/project.mjs';
import { defaultSettings } from '../../src/domain/model/document.mjs';
import { defaultMotionSettings, minimumMotionDuration } from '../../src/motion/effects.mjs';

export function createRecordingMotionSample() {
  const project = createBlankProject();
  project.name = '录屏动效试作 · 门外';
  const chapter = project.chapters[0];
  chapter.name = '独立短篇 · 非正式剧情';
  const lines = [
    ['门外的脚步停了。', 'none'],
    ['请记得\n这一刻。', 'verticalReveal'],
    ['声音恢复时，那句话仍然清楚。', 'ghostConverge'],
    ['我把门打开。', 'none'],
  ];
  chapter.document.blocks = lines.map(([text, motion], index) => {
    const motionSettings = defaultMotionSettings(motion, text);
    return { type: 'paragraph', id: `rp-sample-p${index}`, children: [{ type: 'cue', id: `rp-sample-c${index}`, children: [{ type: 'text', text }], settings: defaultSettings({ mode: 'free', fontSize: 68, motion, motionSettings, advance: 'timed', durationMs: Math.max(2500, minimumMotionDuration(motion, text, motionSettings)) }) }] };
  });
  return project;
}
