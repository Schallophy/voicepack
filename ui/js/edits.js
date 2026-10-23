export function normalizeSegments(segments, total) {
  const out = [];
  for (const seg of segments) {
    let start = Math.max(0, Math.round(seg.start));
    let end = Number.isFinite(total) ? Math.min(total, Math.round(seg.end)) : Math.round(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const last = out[out.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

export function totalLength(segments) {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0);
}

export function keepRenderedRange(segments, from, to) {
  const out = [];
  let cursor = 0;
  for (const seg of segments) {
    const len = seg.end - seg.start;
    const rStart = cursor;
    const rEnd = cursor + len;
    const a = Math.max(from, rStart);
    const b = Math.min(to, rEnd);
    if (b > a) out.push({ start: seg.start + (a - rStart), end: seg.start + (b - rStart) });
    cursor = rEnd;
  }
  return normalizeSegments(out);
}

export function removeRenderedRange(segments, from, to) {
  const out = [];
  let cursor = 0;
  for (const seg of segments) {
    const len = seg.end - seg.start;
    const rStart = cursor;
    const rEnd = cursor + len;
    const a = Math.max(from, rStart);
    const b = Math.min(to, rEnd);
    if (b <= a) {
      out.push({ ...seg });
    } else {
      if (a > rStart) out.push({ start: seg.start, end: seg.start + (a - rStart) });
      if (b < rEnd) out.push({ start: seg.start + (b - rStart), end: seg.end });
    }
    cursor = rEnd;
  }
  return normalizeSegments(out);
}

export function segmentsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  }
  return true;
}

export function fullSegments(length) {
  return length > 0 ? [{ start: 0, end: length }] : [];
}

export function findAudibleBounds(buffer, thresholdDb = -50, padSec = 0.05) {
  const total = buffer.length;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const threshold = Math.pow(10, thresholdDb / 20);

  let first = -1;
  for (let i = 0; i < total; i++) {
    let peak = 0;
    for (const data of channels) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    if (peak > threshold) { first = i; break; }
  }
  if (first < 0) return null;

  let last = first;
  for (let i = total - 1; i >= first; i--) {
    let peak = 0;
    for (const data of channels) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    if (peak > threshold) { last = i; break; }
  }

  const pad = Math.round(padSec * buffer.sampleRate);
  return {
    start: Math.max(0, first - pad),
    end: Math.min(total, last + pad),
  };
}
