type Progress = (label: string) => void;

export async function extractAudioFromVideo(blob: Blob, { signal, name = 'MP4音轨', onProgress = () => {} }: { signal?: AbortSignal; name?: string; onProgress?: Progress } = {}): Promise<File> {
  if (blob.type !== 'video/mp4') throw new Error('音轨提取目前只支持 MP4 视频。');
  if (blob.size > 100 * 1024 * 1024) throw new Error('视频文件超过 100 MB，无法安全提取。');
  if (signal?.aborted) throw new DOMException('已取消音轨提取。', 'AbortError');
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) throw new Error('当前桌面运行环境没有可用的音频解码器。');
  const context = new AudioContextClass();
  let decoded: AudioBuffer;
  try {
    onProgress('正在读取并解码 MP4 音轨…');
    const input = await blob.arrayBuffer();
    decoded = await context.decodeAudioData(input);
  } catch (error) {
    throw new Error(`未发现可读取的音轨，或视频使用了当前播放器不支持的编码。${error instanceof Error ? ` ${error.message}` : ''}`);
  } finally {
    await context.close().catch(() => {});
  }
  if (signal?.aborted) throw new DOMException('已取消音轨提取。', 'AbortError');
  if (!decoded.length || !decoded.numberOfChannels) throw new Error('视频中没有可提取的音轨。');
  const channels = Math.min(2, decoded.numberOfChannels);
  const dataBytes = decoded.length * channels * 2;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 100 * 1024 * 1024 - 44) throw new Error('提取后的 WAV 将超过单个素材 100 MB 的上限，已停止以保护内存。');
  if (decoded.duration > 60 * 60) throw new Error('视频超过 60 分钟，当前版本暂不提取。');
  const wav = await encodeWav(decoded, channels, signal, onProgress);
  const baseName = name.replace(/\.mp4$/i, '') || 'MP4音轨';
  return new File([wav], `${baseName}.wav`, { type: 'audio/wav' });
}

export async function encodeWav(audio: AudioBuffer, channelCount = Math.min(2, audio.numberOfChannels), signal?: AbortSignal, onProgress: Progress = () => {}): Promise<ArrayBuffer> {
  const channels = Math.min(2, Math.max(1, channelCount));
  const sampleRate = audio.sampleRate;
  const dataBytes = audio.length * channels * 2;
  const output = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(output);
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data'); view.setUint32(40, dataBytes, true);
  const sourceChannels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  const chunkFrames = Math.max(1, sampleRate);
  for (let start = 0; start < audio.length; start += chunkFrames) {
    if (signal?.aborted) throw new DOMException('已取消音轨提取。', 'AbortError');
    const end = Math.min(audio.length, start + chunkFrames);
    let offset = 44 + start * channels * 2;
    for (let frame = start; frame < end; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        let sample: number;
        if (audio.numberOfChannels <= 2) sample = sourceChannels[channel][frame];
        else {
          sample = 0;
          for (let source = 0; source < audio.numberOfChannels; source += 1) sample += sourceChannels[source][frame] / audio.numberOfChannels;
        }
        const clipped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
        offset += 2;
      }
    }
    onProgress(`正在封装 WAV… ${Math.round(end / audio.length * 100)}%`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return output;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
