'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { HiMail, HiHeart } from 'react-icons/hi';
import { SiGithub } from 'react-icons/si';
import { FaExternalLinkAlt } from 'react-icons/fa';
import { useI18n } from '@/i18n/I18nProvider';

const Footer: React.FC = () => {
  const { t } = useI18n();

  const footerSections: Record<string, { title: string; links: { name: string; href: string; external: boolean }[] }> = {
    product: {
      title: t('footer.product'),
      links: [
        { name: t('footer.about'), href: '/about', external: false },
        { name: t('footer.changelog'), href: '/changelog', external: false },
      ]
    },
    support: {
      title: t('footer.support'),
      links: [
        { name: t('footer.help'), href: '/help', external: false },
        { name: t('footer.docs'), href: '/docs', external: false },
        { name: t('footer.issues'), href: 'https://github.com/ptnghia-j/ChordMiniApp/issues', external: true },
      ]
    },
    legal: {
      title: t('footer.legal'),
      links: [
        { name: t('footer.privacy'), href: '/privacy', external: false },
        { name: t('footer.terms'), href: '/terms', external: false },
      ]
    }
  };

  const socialLinks = [
    {
      name: 'GitHub',
      href: 'https://github.com/ptnghia-j/ChordMiniApp',
      icon: <SiGithub className="w-5 h-5" />,
    },
    // {
    //   name: 'arXiv Paper',
    //   href: 'https://arxiv.org/abs/2602.19778',
    //   icon: <SiArxiv className="w-5 h-5" />,
    // },
  ];

  return (
    <footer className="relative z-20 overflow-hidden border-t border-white/45 bg-white/82 backdrop-blur-xl transition-colors duration-300 dark:border-white/10 dark:bg-dark-bg/82">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/45 to-transparent dark:from-white/5" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* Main Footer Content */}
        <div className="py-12">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8">

            {/* Brand Section */}
            <div className="lg:col-span-2">
              <div className="flex items-center space-x-3 mb-4">
                <Link href="/">
                  {/* Light theme logo - hidden in dark mode */}
                  <Image
                    src="/chordMiniLogo.webp"
                    alt={t('nav.logo')}
                    width={40}
                    height={40}
                    sizes="40px"
                    className="w-10 h-10 block dark:hidden rounded-lg"
                  />
                  {/* Dark theme logo - hidden in light mode */}
                  <Image
                    src="/chordMiniLogo-dark.webp"
                    alt={t('nav.logo')}
                    width={40}
                    height={40}
                    sizes="40px"
                    className="w-10 h-10 hidden dark:block rounded-lg"
                  />
                </Link>
                <div>
                  <h3 className="text-xl font-nunito font-extrabold text-gray-900 dark:text-white tracking-tight">
                    ChordMini
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {t('footer.tagline')}
                  </p>
                </div>
              </div>

              {/* Social Links */}
              <div className="flex space-x-4">
                {socialLinks.map((social) => (
                  <a
                    key={social.name}
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200"
                    aria-label={social.name}
                  >
                    {social.icon}
                  </a>
                ))}
              </div>
            </div>

            {/* Navigation Sections */}
            {Object.entries(footerSections).map(([key, section]) => (
              <div key={key}>
                <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
                  {section.title}
                </h4>
                <ul className="space-y-3">
                  {section.links.map((link) => (
                    <li key={link.name}>
                      {link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200 flex items-center space-x-1"
                        >
                          <span>{link.name}</span>
                          <FaExternalLinkAlt className="w-3 h-3" />
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200"
                        >
                          {link.name}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Section */}
        <div className="py-6 border-t border-gray-200 dark:border-gray-700">
          <div className="flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">

            {/* Left Side - Copyright and Contact */}
            <div className="flex flex-col sm:flex-row items-center space-y-2 sm:space-y-0 sm:space-x-6">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                © {new Date().getFullYear()} ChordMini. {t('footer.rights')}
              </p>
              <div className="flex items-center space-x-2">
                <HiMail className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                <a
                  href="mailto:phantrongnghia510@gmail.com"
                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200"
                >
                  phantrongnghia510@gmail.com
                </a>
              </div>
            </div>

            {/* Right Side - Version and Support */}
            <div className="flex items-center space-x-6">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t('footer.version', { version: '0.6.5' })}
              </span>
              <a
                href="https://buymeacoffee.com/nghiaphan"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400 hover:text-orange-500 dark:hover:text-orange-400 transition-colors duration-200"
              >
                <HiHeart className="w-4 h-4" />
                <span>{t('footer.support')}</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
