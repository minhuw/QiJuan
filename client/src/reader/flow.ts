import type { ReaderFlow } from './epub/settings';

const FLOW_KEY = 'qijuan.reader.flow';

export function readReaderFlow(): ReaderFlow {
  try {
    const saved = localStorage.getItem(FLOW_KEY);
    return saved === 'continuous' || saved === 'spread' ? saved : 'paginated';
  } catch {
    return 'paginated';
  }
}

export function saveReaderFlow(flow: ReaderFlow): void {
  try {
    localStorage.setItem(FLOW_KEY, flow);
  } catch {
    // Reading remains available when browser storage is disabled.
  }
}
