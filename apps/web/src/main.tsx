import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { applyRememberedBrand } from './lib/theme';
import './styles/global.css';

applyRememberedBrand();

// Recipients get a small bundle of their own: no router, no query cache, no staff or admin code.
const isRecipient = /^\/r\/[^/]+\/?$/.test(window.location.pathname);
const Root = isRecipient ? lazy(() => import('./pages/Recipient')) : lazy(() => import('./StaffApp'));

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
      <Root />
    </Suspense>
  </React.StrictMode>,
);
