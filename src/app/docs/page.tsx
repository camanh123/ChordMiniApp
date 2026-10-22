// src/app/docs/page.tsx
'use client';

import { useEffect, useState } from 'react';
import Navigation from '@/components/common/Navigation';
import { isDevelopmentEnvironment } from '@/utils/modelFiltering';
import { CodeBlock } from '@/components/common/CodeBlock';
import { useTheme } from '@/contexts/ThemeContext';
import { useI18n } from '@/i18n/I18nProvider';

import {
  FiActivity,
  FiCpu,
  FiLink,
  FiFileText,
  FiCheckCircle,
  FiExternalLink,
  FiCode,
  FiServer,
  FiZap,
  FiAlertCircle,
  FiInfo
} from 'react-icons/fi';
import { Card, CardBody, Chip } from '@heroui/react';

// Reusable Status Icon Component
interface ModelCardProps {
  title: string;
  description: React.ReactNode;
  footer: React.ReactNode;
  badgeLabel?: string;
  badgeColor?: 'success' | 'warning';
  accentClassName?: string;
}

const ModelCard = ({
  title,
  description,
  footer,
  badgeLabel,
  badgeColor = 'success',
  accentClassName = 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-900',
}: ModelCardProps) => {
  const { t } = useI18n();
  return (
  <Card shadow="sm" className={`transition-all hover:shadow-lg ${accentClassName}`}>
    <CardBody className="p-6">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-3 h-3 bg-slate-400 rounded-full" aria-hidden="true" />
        <h4 className="font-semibold text-gray-900 dark:text-white">{title}</h4>
        <Chip size="sm" variant="flat">{t('docs.unverified')}</Chip>
        {badgeLabel ? (
          <Chip
            size="sm"
            variant="flat"
            color={badgeColor}
            className="font-medium"
          >
            {badgeLabel}
          </Chip>
        ) : null}
      </div>
      <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">
        {description}
      </p>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {footer}
      </div>
    </CardBody>
  </Card>
  );
};

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState<string>('welcome');
  // Consume theme to toggle a CSS class for docs without referencing the value directly
  const { theme } = useTheme();
  const { t } = useI18n();
  // no-op read to satisfy linter while keeping reactive subscription
  void theme;

  // Use environment variable for backend URL (supports runtime configuration)
  // Fallback to localhost:5001 for local development
  const localEndpoint = 'http://localhost:5001';

  useEffect(() => {
    const sectionIds = [
      'welcome',
      'getting-started',
      'authentication',
      'rate-limits',
      'models',
      'endpoints',
      'examples',
      'sample-responses',
      'status'
    ];

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        });
      },
      {
        rootMargin: '-20% 0px -80% 0px' // Adjusted for better section tracking
      }
    );

    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  const navItemClasses = (id: string) =>
    `flex items-center gap-2 text-sm py-2 px-3 rounded-md transition-colors ${
      activeSection === id
        ? 'bg-[#E8EDF6] dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-semibold'
        : 'text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-[#F5EFE4] dark:hover:bg-gray-800'
    }`;

  const infoCardClass = (type: 'info' | 'warning' | 'success') => {
    switch (type) {
      case 'info':
        return 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-blue-500 dark:border-blue-400';
      case 'warning':
        return 'bg-amber-50 dark:bg-amber-900/20 border-l-4 border-amber-500 dark:border-amber-400';
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-l-4 border-green-500 dark:border-green-400';
    }
  };

  return (
    <div className="min-h-screen bg-background dark:bg-content-bg transition-colors duration-300">
      <Navigation />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8">
        <div className="lg:grid lg:grid-cols-4 lg:gap-8">
          {/* Sidebar Navigation */}
          <div className="hidden lg:block lg:col-span-1 bg-[#FAF6EE] dark:bg-content-bg transition-colors duration-300">
            <div className="sticky top-20 rounded-2xl bg-[#FAF6EE] py-8 dark:bg-content-bg transition-colors duration-300">
              <nav className="space-y-6 bg-[#FAF6EE] dark:bg-content-bg">
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    {t('docs.navWelcome')}
                  </h3>
                  <a href="#welcome" className={navItemClasses('welcome')}>
                    <FiInfo className="w-4 h-4" /> {t('docs.navOverview')}
                  </a>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    {t('docs.navStart')}
                  </h3>
                  <a href="#getting-started" className={navItemClasses('getting-started')}>
                    <FiZap className="w-4 h-4" /> {t('docs.navQuick')}
                  </a>
                  <a href="#authentication" className={navItemClasses('authentication')}>
                    <FiCheckCircle className="w-4 h-4" /> {t('docs.navAuth')}
                  </a>
                  <a href="#rate-limits" className={navItemClasses('rate-limits')}>
                    <FiActivity className="w-4 h-4" /> {t('docs.navRates')}
                  </a>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    {t('docs.navReference')}
                  </h3>
                  <a href="#models" className={navItemClasses('models')}>
                    <FiCpu className="w-4 h-4" /> {t('docs.navModels')}
                  </a>
                  <a href="#endpoints" className={navItemClasses('endpoints')}>
                    <FiLink className="w-4 h-4" /> {t('docs.navEndpoints')}
                  </a>
                  <a href="#examples" className={navItemClasses('examples')}>
                    <FiCode className="w-4 h-4" /> {t('docs.navExamples')}
                  </a>
                  <a href="#sample-responses" className={navItemClasses('sample-responses')}>
                    <FiFileText className="w-4 h-4" /> {t('docs.navResponses')}
                  </a>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    {t('docs.navSupport')}
                  </h3>
                  <a href="#status" className={navItemClasses('status')}>
                    <FiServer className="w-4 h-4" /> {t('docs.navStatus')}
                  </a>
                </div>
              </nav>
            </div>
          </div>

          {/* Main Content Area */}
          <div className="lg:col-span-3 min-w-0 py-8">
            <div className="space-y-16">
              {/* Welcome / Overview */}
              <section id="welcome" className="scroll-mt-8">
                <div className="text-center space-y-4">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-900/20 mx-auto">
                    <FiCode className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                  </div>
                  <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900 dark:text-white leading-tight">
                    {t('docs.title')}
                  </h1>
                  <p className="text-lg sm:text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
                    {t('docs.intro')}
                  </p>
                </div>
              </section>

              {/* Getting Started */}
              <section id="getting-started" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.gettingStarted')}</h2>
                <div className="prose prose-gray dark:prose-invert max-w-none mb-8">
                  <p>
                    {t('docs.gettingBody')}
                  </p>
                </div>

                {/* Feature Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-6 mb-8">
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700">
                    <CardBody>
                      <div className="flex items-center gap-4 mb-2">
                        <FiActivity className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                        <h3 className="font-semibold text-gray-900 dark:text-white text-lg">{t('docs.beatTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('docs.beatBody')}
                      </p>
                    </CardBody>
                  </Card>
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700">
                    <CardBody>
                      <div className="flex items-center gap-4 mb-2">
                        <FiCpu className="w-6 h-6 text-green-600 dark:text-green-400" />
                        <h3 className="font-semibold text-gray-900 dark:text-white text-lg">{t('docs.chordTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('docs.chordBody')}
                      </p>
                    </CardBody>
                  </Card>
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700">
                    <CardBody>
                      <div className="flex items-center gap-4 mb-2">
                        <FiFileText className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                        <h3 className="font-semibold text-gray-900 dark:text-white text-lg">{t('docs.lyricsTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('docs.lyricsBody')}
                      </p>
                    </CardBody>
                  </Card>
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700">
                    <CardBody>
                      <div className="flex items-center gap-4 mb-2">
                        <FiServer className="w-6 h-6 text-orange-600 dark:text-orange-400" />
                        <h3 className="font-semibold text-gray-900 dark:text-white text-lg">{t('docs.modelInfoTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('docs.modelInfoBody')}
                      </p>
                    </CardBody>
                  </Card>
                </div>
              </section>

              {/* Authentication */}
              <section id="authentication" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.authTitle')}</h2>
                <div className={`rounded-lg p-6 mb-6 ${infoCardClass('success')}`}>
                  <div className="flex items-start gap-3">
                    <FiCheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-green-900 dark:text-green-100 mb-2">{t('docs.noKeyTitle')}</h3>
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {t('docs.noKeyBody')}
                      </p>
                    </div>
                  </div>
                </div>
                <div className={`rounded-lg p-6 ${infoCardClass('warning')}`}>
                  <div className="flex items-start gap-3">
                    <FiAlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-amber-900 dark:text-amber-100 mb-2">{t('docs.futureTitle')}</h3>
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {t('docs.futureBody')}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {/* Rate Limits */}
              <section id="rate-limits" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.ratesTitle')}</h2>
                <div className="prose prose-gray dark:prose-invert max-w-none mb-8">
                  <p>
                    {t('docs.ratesBody')}
                  </p>
                </div>
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-100 dark:bg-content-bg/50 border-b border-gray-200 dark:border-gray-700">
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('docs.colEndpoint')}</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('docs.colMethod')}</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('docs.colLimit')}</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('docs.colReason')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      <tr className="bg-white dark:bg-slate-900">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">/</td>
                        <td className="px-6 py-4 whitespace-nowrap"><span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">GET</span></td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-gray-100">{t('docs.perMinute', { count: 30 })}</td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('docs.reasonHealth')}</td>
                      </tr>
                      <tr className="bg-white dark:bg-slate-900">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">/api/model-info</td>
                        <td className="px-6 py-4 whitespace-nowrap"><span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">GET</span></td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-gray-100">{t('docs.perMinute', { count: 20 })}</td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('docs.reasonInfo')}</td>
                      </tr>
                      <tr className="bg-white dark:bg-slate-900">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">/api/detect-beats</td>
                        <td className="px-6 py-4 whitespace-nowrap"><span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">POST</span></td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-red-600 dark:text-red-400">{t('docs.perMinute', { count: 2 })}</td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('docs.reasonHeavy')}</td>
                      </tr>
                      <tr className="bg-white dark:bg-slate-900">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">/api/recognize-chords*</td>
                        <td className="px-6 py-4 whitespace-nowrap"><span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">POST</span></td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-red-600 dark:text-red-400">{t('docs.perMinute', { count: 2 })}</td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('docs.reasonMl')}</td>
                      </tr>
                      <tr className="bg-white dark:bg-slate-900">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">/api/lrclib-lyrics</td>
                        <td className="px-6 py-4 whitespace-nowrap"><span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">POST</span></td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-gray-100">{t('docs.perMinute', { count: 10 })}</td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('docs.reasonLyrics')}</td>
                      </tr>
                      <tr className="bg-white dark:bg-slate-900">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">{t('docs.lrclibSearch')}</td>
                        <td className="px-6 py-4 whitespace-nowrap"><span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">POST</span></td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-gray-100">{t('docs.perMinute', { count: 10 })}</td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('docs.reasonLookup')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Models */}
              <section id="models" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.modelsTitle')}</h2>
                <div className="prose prose-gray dark:prose-invert max-w-none mb-8">
                  <p>
                    {t('docs.modelsBody')}
                  </p>
                </div>
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('docs.beatModels')}</h3>
                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  <ModelCard
                    title="Madmom"
                    badgeLabel={t('docs.defaultBadge')}
                    description={t('docs.madmomBody')}
                    footer={<><strong>{t('docs.bestFor')}</strong> {t('docs.madmomBest')}</>}
                  />
                  <ModelCard
                    title="Beat-Transformer"
                    description={t('docs.beatTransformerBody')}
                    footer={<><strong>{t('docs.bestFor')}</strong> {t('docs.beatTransformerBest')}</>}
                  />
                </div>

                <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('docs.chordModels')}</h3>
                <div className="grid gap-6">
                  <ModelCard
                    title="Chord-CNN-LSTM"
                    badgeLabel={t('docs.defaultBadge')}
                    description={t('docs.cnnBody')}
                    footer={<><strong>{t('docs.labels')}</strong> {t('docs.cnnLabels')} • <strong>{t('docs.bestFor')}</strong> {t('docs.cnnBest')}</>}
                  />
                  {isDevelopmentEnvironment() && (
                    <>
                      <ModelCard
                        title="BTC SL"
                        badgeLabel={t('docs.devOnly')}
                        badgeColor="warning"
                        accentClassName="border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20"
                        description={
                          <>
                            {t('docs.btcBody')} {t('docs.btcSlExtra')}
                            <strong className="text-orange-600 dark:text-orange-400"> {t('docs.btcDevNote')}</strong>
                          </>
                        }
                        footer={<><strong>{t('docs.labels')}</strong> {t('docs.btcLabels')} • <strong>{t('docs.bestFor')}</strong> {t('docs.btcBest')}</>}
                      />
                      <ModelCard
                        title="BTC PL"
                        badgeLabel={t('docs.devOnly')}
                        badgeColor="warning"
                        accentClassName="border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20"
                        description={
                          <>
                            {t('docs.btcBody')} {t('docs.btcPlExtra')}
                            <strong className="text-orange-600 dark:text-orange-400"> {t('docs.btcDevNote')}</strong>
                          </>
                        }
                        footer={<><strong>{t('docs.labels')}</strong> {t('docs.btcLabels')} • <strong>{t('docs.bestFor')}</strong> {t('docs.btcBest')}</>}
                      />
                    </>
                  )}
                </div>
              </section>

              {/* API Endpoints */}
              <section id="endpoints" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.endpointsTitle')}</h2>
                <div className="prose prose-gray dark:prose-invert max-w-none mb-8">
                  <p>
                    {t('docs.localEndpoints')} <strong className="font-mono text-gray-900 dark:text-white">{localEndpoint}</strong>
                  </p>
                </div>
                <div className={`rounded-lg p-4 mb-6 ${infoCardClass('info')}`}>
                  <div className="flex items-start gap-3">
                    <FiInfo className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      {t('docs.remoteNote')}
                    </p>
                  </div>
                </div>
                <div className="grid gap-6">
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-900">
                    <CardBody>
                      <div className="flex items-center gap-3 mb-4">
                        <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">POST</span>
                        <span className="font-mono text-sm text-gray-900 dark:text-gray-100">/api/detect-beats</span>
                      </div>
                      <p className="text-gray-600 dark:text-gray-400 mb-4">
                        {t('docs.detectBeatsBody')}
                      </p>
                      <ul className="text-sm space-y-2">
                        <li><strong>{t('docs.parameters')}</strong> <span className="font-mono">{t('docs.detectBeatsParams')}</span></li>
                      </ul>
                    </CardBody>
                  </Card>
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-900">
                    <CardBody>
                      <div className="flex items-center gap-3 mb-4">
                        <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">POST</span>
                        <span className="font-mono text-sm text-gray-900 dark:text-gray-100">/api/recognize-chords</span>
                      </div>
                      <p className="text-gray-600 dark:text-gray-400 mb-4">
                        {t('docs.recognizeBody')}
                      </p>
                      <ul className="text-sm space-y-2">
                        <li><strong>{t('docs.parameters')}</strong> <span className="font-mono">{t('docs.recognizeParams')}</span></li>
                      </ul>
                    </CardBody>
                  </Card>
                </div>
              </section>

              {/* Examples */}
              <section id="examples" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.examplesTitle')}</h2>
                <div className="prose prose-gray dark:prose-invert max-w-none mb-8">
                  <p>
                    {t('docs.examplesBody')}
                  </p>
                </div>

                <div className="space-y-8">
                  <div>
                    <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('docs.exampleChordJs')}</h3>
                    <CodeBlock
                      title="Javascript"
                      language="javascript"
                      code={`const formData = new FormData();
formData.append('file', audioFile);
formData.append('model', 'chord-cnn-lstm');

const response = await fetch(
  '${localEndpoint}/api/recognize-chords',
  {
    method: 'POST',
    body: formData
  }
);

const result = await response.json();
console.log(result);`}
                    />
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('docs.exampleBeatCurl')}</h3>
                    <CodeBlock
                      title="cURL"
                      language="bash"
                      code={`curl -X POST "${localEndpoint}/api/detect-beats" \\
  -F "file=@your-audio-file.mp3" \\
  -F "model=beat-transformer"`}
                    />
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('docs.exampleChordCurl')}</h3>
                    <CodeBlock
                      title="cURL"
                      language="bash"
                      code={`curl -X POST "${localEndpoint}/api/recognize-chords" \\
  -F "file=@your-audio-file.mp3" \\
  -F "model=chord-cnn-lstm"`}
                    />
                  </div>
                </div>
              </section>

              {/* Status Page */}
              <section id="status" className="scroll-mt-8">
                <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">{t('docs.statusTitle')}</h2>
                <div className="prose prose-gray dark:prose-invert max-w-none mb-8">
                  <p>
                    {t('docs.statusBody')}
                  </p>
                </div>

                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-900">
                    <CardBody>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-3 h-3 bg-slate-400 rounded-full" aria-hidden="true" />
                        <h3 className="font-semibold text-gray-900 dark:text-white">{t('docs.backendServices')}</h3>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-sm text-gray-600 dark:text-gray-400">
                          <span>{t('docs.beatTitle')}</span>
                          <span className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-1 rounded-full">{t('docs.unverified')}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm text-gray-600 dark:text-gray-400">
                          <span>{t('docs.chordTitle')}</span>
                          <span className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-1 rounded-full">{t('docs.unverified')}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm text-gray-600 dark:text-gray-400">
                          <span>{t('docs.lyricsServices')}</span>
                          <span className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-1 rounded-full">{t('docs.unverified')}</span>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                  <Card shadow="sm" className="hover:shadow-lg transition-all border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-900">
                    <CardBody>
                      <div className="flex items-center gap-3 mb-4">
                        <FiServer className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                        <h3 className="font-semibold text-gray-900 dark:text-white">{t('docs.infrastructure')}</h3>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-sm text-gray-600 dark:text-gray-400">
                          <span>Google Cloud Run</span>
                          <span className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-1 rounded-full">{t('docs.unverified')}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm text-gray-600 dark:text-gray-400">
                          <span>{t('docs.rateLimiting')}</span>
                          <span className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-1 rounded-full">{t('docs.unverified')}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm text-gray-600 dark:text-gray-400">
                          <span>{t('docs.cors')}</span>
                          <span className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-1 rounded-full">{t('docs.unverified')}</span>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </div>
                <div className={`rounded-lg p-6 ${infoCardClass('info')}`}>
                  <div className="flex items-start gap-3">
                    <FiExternalLink className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">{t('docs.detailedStatus')}</h3>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                        {t('docs.detailedStatusBody')}
                      </p>
                      <a href="/status" className="inline-flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium text-sm transition-colors">
                        {t('docs.viewStatus')}
                        <FiExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
