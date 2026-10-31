import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/source-serif-4/opsz.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/600.css';
import { App } from './App';
import './styles/tokens.css';
import './styles/globals.css';
import './styles/app.css';
import './styles/book-reader.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
