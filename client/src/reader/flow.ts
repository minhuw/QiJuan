import type { ReaderFlow } from './epub/settings';

const FLOW_KEY = 'qijuan.reader.flow';

export function readReaderFlow(): ReaderFlow {
  try {
    return localStorage.getItem(FLOW_KEY) === 'continuous' ? 'continuous' : 'paginated';
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
