import { BrowserRouter } from 'react-router';
import { Gate } from './gate';
import { Shell } from './shell';

export function App({ locale }: { locale?: string }) {
  return (
    <BrowserRouter>
      <Shell locale={locale}>
        <Gate />
      </Shell>
    </BrowserRouter>
  );
}
