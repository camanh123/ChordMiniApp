import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server.node';
import { I18nProvider } from '@/i18n/I18nProvider';
import AppFooter from '@/components/common/AppFooter';
import DesktopPolicyLinks from '@/components/common/DesktopPolicyLinks';
import { shouldRenderWebsiteFooter } from '@/components/common/websiteFooter';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt || ''} />,
}));

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
}

function setDisplayMode(mode: string | null) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: mode !== null && query === `(display-mode: ${mode})`,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
}

function renderShell(ui: React.ReactNode) {
  return render(
    <I18nProvider initialLocale="en-US">
      <div className="min-h-screen flex flex-col">
        <main className="flex-1">
          <h1>Analysis workspace</h1>
        </main>
        {ui}
      </div>
    </I18nProvider>,
  );
}

describe('website footer on desktop and web', () => {
  const originalRuntime = process.env.NEXT_PUBLIC_APP_RUNTIME;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    setUserAgent('Mozilla/5.0');
    setDisplayMode('browser');
  });

  afterEach(() => {
    if (originalRuntime === undefined) {
      delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    } else {
      process.env.NEXT_PUBLIC_APP_RUNTIME = originalRuntime;
    }
  });

  it('keeps the website footer and its links in a browser session', () => {
    renderShell(<AppFooter />);

    expect(document.querySelector('footer')).not.toBeNull();
    expect(screen.getByText('ChordMini')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'phantrongnghia510@gmail.com' })).toBeInTheDocument();
    expect(screen.getByText('Version 0.6.5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analysis workspace' })).toBeInTheDocument();
  });

  it('keeps the website footer for an installed PWA', () => {
    setDisplayMode('standalone');
    renderShell(<AppFooter />);
    expect(document.querySelector('footer')).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Legal' })).not.toBeInTheDocument();
  });

  it('omits the footer in an Electron session so it reserves no layout node', () => {
    setUserAgent('Mozilla/5.0 Electron/30.0 ChordMini');
    const view = renderShell(<AppFooter />);

    expect(view.container.querySelector('footer')).toBeNull();
    expect(screen.queryByText('Version 0.6.5')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy Policy' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analysis workspace' })).toBeInTheDocument();
    expect(view.container.querySelector('main')).toHaveClass('flex-1');
  });

  it('omits the footer on the client when the desktop runtime is pinned', () => {
    process.env.NEXT_PUBLIC_APP_RUNTIME = 'electron';
    const view = renderShell(<AppFooter />);
    expect(view.container.querySelector('footer')).toBeNull();
  });

  it('keeps the server footer while hydration is still on the shared snapshot', () => {
    process.env.NEXT_PUBLIC_APP_RUNTIME = 'electron';
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <AppFooter />
      </I18nProvider>,
    );
    expect(html).toContain('<footer');
  });

  it('renders the website footer from the server when the runtime is web', () => {
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <AppFooter />
      </I18nProvider>,
    );
    expect(html).toContain('<footer');
    expect(html).toContain('Privacy Policy');
    expect(html).toContain('Version 0.6.5');
  });

  it('links the privacy policy and terms from settings only in Electron', () => {
    const website = render(
      <I18nProvider initialLocale="en-US">
        <DesktopPolicyLinks />
      </I18nProvider>,
    );
    expect(website.container).toBeEmptyDOMElement();
    website.unmount();

    setUserAgent('Mozilla/5.0 Electron/30.0 ChordMini');
    render(
      <I18nProvider initialLocale="en-US">
        <DesktopPolicyLinks />
      </I18nProvider>,
    );
    expect(screen.getByRole('navigation', { name: 'Legal' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
  });

  it('mounts the footer gate in the shared layout without hiding it through global CSS', () => {
    const root = path.resolve(__dirname, '../../..');
    const layout = fs.readFileSync(path.join(root, 'src/app/layout.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8');
    const footer = fs.readFileSync(path.join(root, 'src/components/common/Footer.tsx'), 'utf8');

    expect(layout).toContain('<main className="flex-1">');
    expect(layout).toContain('{showWebsiteFooter ? <AppFooter /> : null}');
    expect(layout).toContain('min-h-screen flex flex-col');
    expect(layout).not.toContain('<Footer />');
    expect(footer).toContain('<footer');
    expect(css).not.toMatch(/footer\s*\{[^}]*display:\s*none/);
  });

  it('omits the website footer from the document when the desktop server is pinned', () => {
    expect(shouldRenderWebsiteFooter({ NEXT_PUBLIC_APP_RUNTIME: 'electron' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldRenderWebsiteFooter({ NEXT_PUBLIC_APP_RUNTIME: ' electron ' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldRenderWebsiteFooter({} as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldRenderWebsiteFooter({ NEXT_PUBLIC_APP_RUNTIME: 'web' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldRenderWebsiteFooter({ NEXT_PUBLIC_APP_RUNTIME: 'pwa' } as NodeJS.ProcessEnv)).toBe(true);

    const desktop = renderToString(
      <div>
        <main className="flex-1">Analysis workspace</main>
        {shouldRenderWebsiteFooter({ NEXT_PUBLIC_APP_RUNTIME: 'electron' } as NodeJS.ProcessEnv)
          ? <footer>website</footer>
          : null}
      </div>,
    );
    const website = renderToString(
      <div>
        <main className="flex-1">Analysis workspace</main>
        {shouldRenderWebsiteFooter({} as NodeJS.ProcessEnv) ? <footer>website</footer> : null}
      </div>,
    );
    expect(desktop).not.toContain('<footer');
    expect(desktop).toContain('Analysis workspace');
    expect(website).toContain('<footer');
  });
});
