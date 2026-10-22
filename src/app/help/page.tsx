'use client';

import React, { useState } from 'react';
import Navigation from '@/components/common/Navigation';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/catalog';

const FAQ_KEYS: Array<{ question: MessageKey; answer: MessageKey }> = [
  { question: 'help.q1', answer: 'help.a1' },
  { question: 'help.q2', answer: 'help.a2' },
  { question: 'help.q3', answer: 'help.a3' },
  { question: 'help.q4', answer: 'help.a4' },
  { question: 'help.q5', answer: 'help.a5' },
  { question: 'help.q6', answer: 'help.a6' },
];

const HelpPage: React.FC = () => {
  const { t } = useI18n();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-dark-bg transition-colors duration-300">
      <Navigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
            {t('help.title')}
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-300 max-w-3xl mx-auto">
            {t('help.intro')}
          </p>
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            {t('help.quick')}
          </h2>
          <div className="space-y-6">
            {([
              ['1', 'help.step1Title', 'help.step1Body'],
              ['2', 'help.step2Title', 'help.step2Body'],
              ['3', 'help.step3Title', 'help.step3Body'],
            ] as const).map(([step, title, body]) => (
              <div key={step} className="flex items-start space-x-4">
                <div className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-medium">
                  {step}
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                    {t(title)}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-300">
                    {t(body)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            {t('help.faq')}
          </h2>
          <div className="space-y-4">
            {FAQ_KEYS.map((faq, index) => (
              <div key={faq.question} className="border border-gray-200 dark:border-gray-600 rounded-lg">
                <button
                  onClick={() => toggleFaq(index)}
                  className="w-full px-6 py-4 text-left flex justify-between items-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-200"
                >
                  <span className="font-medium text-gray-900 dark:text-white">
                    {t(faq.question)}
                  </span>
                  <svg
                    className={`w-5 h-5 text-gray-500 transform transition-transform duration-200 ${
                      openFaq === index ? 'rotate-180' : ''
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openFaq === index && (
                  <div className="px-6 pb-4">
                    <p className="text-gray-600 dark:text-gray-300">
                      {t(faq.answer)}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            {t('help.more')}
          </h2>
          <div className="space-y-4 text-gray-700 dark:text-gray-300">
            <p>
              {t('help.reach')}
            </p>
            <div className="space-y-2">
              <p><strong>{t('help.email')}</strong> <a href="mailto:phantrongnghia510@gmail.com" className="text-blue-600 dark:text-blue-400 hover:underline">phantrongnghia510@gmail.com</a></p>
              <p><strong>{t('help.github')}</strong> <a href="https://github.com/ptnghia-j/ChordMiniApp/issues" className="text-blue-600 dark:text-blue-400 hover:underline">{t('help.githubLink')}</a></p>
              <p><strong>{t('help.response')}</strong> {t('help.responseBody')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HelpPage;
