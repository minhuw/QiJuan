import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from './shell';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}
