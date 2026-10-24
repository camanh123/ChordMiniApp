import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { APP_LOCALES, DEFAULT_LOCALE, localeCookieAssignment, readLocaleFromCookieHeader } from '@/i18n/locales';
import { catalog, type MessageKey } from '@/i18n/catalog';
import { I18nProvider, useI18n } from '@/i18n/I18nProvider';
import { translate } from '@/i18n/translate';

function LanguageProbe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <p>{t('home.tagline')}</p>
      <p data-testid="locale">{locale}</p>
      <button type="button" onClick={() => setLocale('ja-JP')}>日本語</button>
    </div>
  );
}

describe('offline locales', () => {
  const originalCookie = document.cookie;

  afterEach(() => {
    document.cookie = 'chordmini_locale=; Path=/; Max-Age=0';
    document.documentElement.lang = 'en';
    window.localStorage.clear();
    void originalCookie;
  });

  it('ships every dictionary key in all five bundled languages', () => {
    const keys = Object.keys(catalog) as MessageKey[];
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      for (const locale of APP_LOCALES) {
        expect(typeof catalog[key][locale]).toBe('string');
        if (!(key === 'games.in' && (locale === 'ja-JP' || locale === 'ko-KR'))) {
          expect(catalog[key][locale].trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('defaults a fresh installation to Vietnamese and keeps a saved choice', () => {
    expect(DEFAULT_LOCALE).toBe('vi-VN');
    expect(readLocaleFromCookieHeader(null)).toBeNull();
    expect(readLocaleFromCookieHeader('chordmini_locale=ko-KR')).toBe('ko-KR');
    expect(readLocaleFromCookieHeader('chordmini_locale=fr-FR')).toBeNull();
  });

  it('stores the language in a host cookie that is not tied to a port', () => {
    const assignment = localeCookieAssignment('vi-VN');
    expect(assignment).toContain('Path=/');
    expect(assignment).toContain('SameSite=Strict');
    expect(assignment).not.toMatch(/Domain=/);
    expect(assignment).not.toMatch(/Secure/);
    expect(assignment).not.toMatch(/HttpOnly/);
    expect(assignment).not.toMatch(/:\d+/);
  });

  it('keeps the same placeholders in every language', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(catalog) as MessageKey[]) {
      const english = placeholders(catalog[key]['en-US']);
      for (const locale of APP_LOCALES) {
        expect(placeholders(catalog[key][locale])).toEqual(english);
      }
    }
  });

  it('covers the reported games, docs, and settings labels in five languages', () => {
    expect(translate('en-US', 'docs.unverified')).toBe('Unverified');
    expect(translate('en-US', 'docs.unverified')).not.toMatch(/Operational|Online|Active/);
    expect(translate('vi-VN', 'games.pageTitle')).toBe('Lý thuyết nhạc và trò chơi tương tác');
    expect(translate('vi-VN', 'games.pageTitle')).not.toBe(catalog['games.pageTitle']['en-US']);
    expect(translate('zh-CN', 'docs.title')).not.toBe(catalog['docs.title']['en-US']);
    expect(translate('ja-JP', 'settings.notConfigured')).toBe('未設定');
    expect(translate('ko-KR', 'settings.notConfigured')).toBe('설정되지 않음');
    expect(translate('vi-VN', 'games.quality.dominant7')).toBe('bảy át');
    expect(translate('en-US', 'games.quality.major')).toBe('major');
    expect(translate('en-US', 'games.reviewAction')).toBe('Review');
    expect(translate('en-US', 'analyze.setupTitle')).toBe('Analysis setup');
    expect(translate('en-US', 'analyze.openAudio')).toBe('Open audio');
    expect(translate('vi-VN', 'analyze.openAudio')).toBe('Mở âm thanh');
    expect(translate('zh-CN', 'analyze.practiceRequirement')).not.toBe(catalog['analyze.practiceRequirement']['en-US']);
    expect(translate('ja-JP', 'analyze.replaceAudio')).toBe('音声を差し替える');
    expect(translate('ko-KR', 'analyze.practiceTitle')).toBe('로컬 연습');
  });

  it('interpolates without contacting a translation service', () => {
    expect(translate('en-US', 'games.prompt.degreeInScale', {
      degree: 3,
      degreeName: 'mediant',
      scale: 'C major',
    })).toBe('Degree 3 (mediant) in C major');
    expect(translate('vi-VN', 'errors.notConfigured')).toBe('Thiếu cấu hình dịch vụ bắt buộc');
    expect(translate('zh-CN', 'nav.home')).toBe('首页');
    expect(translate('ja-JP', 'nav.settings')).toBe('設定');
    expect(translate('ko-KR', 'settings.language')).toBe('언어');
  });

  it('switches the visible language immediately and writes the cookie', () => {
    render(
      <I18nProvider initialLocale="vi-VN">
        <LanguageProbe />
      </I18nProvider>,
    );
    expect(screen.getByText(/Ứng dụng mã nguồn mở/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.getByText(/オープンソースのコードとビート検出アプリ/)).toBeInTheDocument();
    expect(screen.getByTestId('locale')).toHaveTextContent('ja-JP');
    expect(document.cookie).toContain('chordmini_locale=ja-JP');
    expect(document.documentElement.lang).toBe('ja-JP');
    expect(window.localStorage.getItem('chordmini_locale')).toBe('ja-JP');
  });

  it('keeps English for components rendered without the provider', () => {
    render(<LanguageProbe />);
    expect(screen.getByText(/Open source chord & beat detection application/)).toBeInTheDocument();
  });

  it('only references catalog keys from the interface', () => {
    const root = path.join(process.cwd(), 'src');
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'i18n') visit(fullPath);
          continue;
        }
        if (/\.(tsx|ts)$/.test(entry.name)) files.push(fullPath);
      }
    };
    visit(root);
    const used = new Set<string>();
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
        used.add(match[1]);
      }
      for (const match of source.matchAll(/\bgt\(\s*'([^']+)'/g)) {
        used.add(match[1]);
      }
    }
    for (const key of used) {
      expect(Object.prototype.hasOwnProperty.call(catalog, key)).toBe(true);
    }
    expect(used.size).toBeGreaterThan(40);
  });
});
