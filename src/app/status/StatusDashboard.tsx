'use client';

import Navigation from '@/components/common/Navigation';
import { Accordion, AccordionItem, Card, CardBody, Chip, Tooltip } from '@heroui/react';
import { FiActivity, FiAlertTriangle, FiCheckCircle, FiMinusCircle, FiXCircle } from 'react-icons/fi';
import type { PublicOverallStatus, PublicStatusIncident, PublicStatusReport, PublicStatusServiceSummary } from '@/services/status/statusTypes';
import { STATUS_SERVICE_IDS } from '@/services/status/statusConstants';
import { useI18n } from '@/i18n/I18nProvider';
import type { Translator } from '@/i18n/translate';

const STATUS_TIMEZONE = 'America/Los_Angeles';
const DATE_PART_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const TIME_PART_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: STATUS_TIMEZONE,
});

function overallLabel(status: PublicOverallStatus, t: Translator): string {
  if (status === 'operational') return t('status.operational');
  if (status === 'degraded') return t('status.degradedOverall');
  if (status === 'partial_outage') return t('status.partial');
  if (status === 'major_outage') return t('status.major');
  return t('status.awaiting');
}

function presentServiceLabel(label: string, t: Translator): string {
  if (label === 'Beat Detection') return t('docs.beatTitle');
  if (label === 'Chord Recognition') return t('docs.chordTitle');
  if (label === 'Sheet Sage') return t('status.sheetSage');
  if (label === 'Gemini API') return t('status.geminiApi');
  return label;
}

function getDayIds(count: number): string[] {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (count - index - 1));
    return date.toISOString().slice(0, 10);
  });
}

function getOverallColor(status: PublicOverallStatus): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'operational') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'partial_outage' || status === 'major_outage') return 'danger';
  return 'default';
}

function getServiceColor(status: PublicStatusServiceSummary['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'operational') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'outage') return 'danger';
  return 'default';
}

function getServiceStatusLabel(status: PublicStatusServiceSummary['status'], t: Translator): string {
  if (status === 'operational') return t('status.svcOperational');
  if (status === 'degraded') return t('status.svcDegraded');
  if (status === 'outage') return t('status.svcOutage');
  return t('status.svcUnknown');
}

function getBarClass(status: PublicStatusServiceSummary['status'] | undefined): string {
  if (status === 'operational') return 'bg-emerald-500 dark:bg-emerald-500';
  if (status === 'degraded') return 'bg-amber-500 dark:bg-amber-500';
  if (status === 'outage') return 'bg-red-600 dark:bg-red-500';
  return 'bg-gray-300/80 dark:bg-gray-600/70';
}

function getServiceBorderClass(index: number, total: number): string {
  const classes = ['border-gray-200', 'dark:border-gray-700'];
  if (index < total - 1) classes.push('border-b');
  if (index >= 2) classes.push('md:border-b-0');
  if (index < 2) classes.push('md:border-b');
  if (index % 2 === 0) classes.push('md:border-r');
  return classes.join(' ');
}

function formatDate(date: string): string {
  const parts = DATE_PART_FORMATTER.formatToParts(new Date(`${date}T12:00:00Z`));
  const month = parts.find((part) => part.type === 'month')?.value || '';
  const day = parts.find((part) => part.type === 'day')?.value || '';
  const year = parts.find((part) => part.type === 'year')?.value || '';
  return `${month} ${day}, ${year}`;
}

function formatTime(value: string | null, t: Translator): string {
  if (!value) return t('status.notChecked');
  const parts = TIME_PART_FORMATTER.formatToParts(new Date(value));
  const month = parts.find((part) => part.type === 'month')?.value || '';
  const day = parts.find((part) => part.type === 'day')?.value || '';
  const hour = parts.find((part) => part.type === 'hour')?.value || '';
  const minute = parts.find((part) => part.type === 'minute')?.value || '';
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value || '';
  return `${month} ${day}, ${hour}:${minute} ${dayPeriod}`.trim();
}

function formatIncidentWindow(incident: PublicStatusIncident, t: Translator): string {
  const started = t('status.detected', { time: formatTime(incident.startedAt, t) });
  if (incident.endedAt) {
    return `${started} · ${t('status.recoveredAt', { time: formatTime(incident.endedAt, t) })}`;
  }
  if (incident.status === 'resolved') {
    return `${started} · ${t('status.recovered')}`;
  }

  return `${started} · ${t('status.awaitingProbe')}`;
}

function getDailyIncidentLabel(report: PublicStatusReport, t: Translator, latestDate?: string): string {
  const incidentCount = report.incidents.length;
  if (incidentCount === 0) {
    return report.date === latestDate ? t('status.noneToday') : t('status.noneReported');
  }

  return t(incidentCount === 1 ? 'status.incidentOne' : 'status.incidentMany', { count: incidentCount });
}

function getDailyIncidentColor(report: PublicStatusReport): 'success' | 'warning' | 'danger' | 'default' {
  if (report.incidents.some((incident) => incident.severity === 'major' || incident.severity === 'critical')) {
    return 'danger';
  }

  if (report.incidents.length > 0) {
    return 'warning';
  }

  return 'success';
}

function getDailyIncidentStatusLabel(report: PublicStatusReport, t: Translator): string {
  if (report.incidents.length === 0) return t('status.clear');
  return report.incidents.some((incident) => incident.status !== 'resolved') ? t('status.investigating') : t('status.recovered');
}

function StatusIcon({ status }: { status: PublicOverallStatus }) {
  if (status === 'operational') return <FiCheckCircle className="h-5 w-5" />;
  if (status === 'degraded') return <FiAlertTriangle className="h-5 w-5" />;
  if (status === 'partial_outage' || status === 'major_outage') return <FiXCircle className="h-5 w-5" />;
  return <FiMinusCircle className="h-5 w-5" />;
}

function ServiceStatusIcon({ status }: { status: PublicStatusServiceSummary['status'] }) {
  if (status === 'operational') return <FiCheckCircle aria-hidden="true" className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />;
  if (status === 'degraded') return <FiAlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-600 dark:text-amber-400" />;
  if (status === 'outage') return <FiXCircle aria-hidden="true" className="h-5 w-5 text-red-600 dark:text-red-400" />;
  return <FiMinusCircle aria-hidden="true" className="h-5 w-5 text-gray-500 dark:text-gray-400" />;
}

function UptimeRow({
  service,
  reports,
  className = '',
}: {
  service: PublicStatusServiceSummary;
  reports: PublicStatusReport[];
  className?: string;
}) {
  const { t } = useI18n();
  const serviceLabel = presentServiceLabel(service.label, t);
  const reportByDate = new Map(reports.map((report) => [report.date, report]));
  const days = getDayIds(90);
  const knownDays = days
    .map((day) => reportByDate.get(day)?.services?.[service.id])
    .filter((entry): entry is PublicStatusServiceSummary => entry !== undefined && entry.totalChecks > 0);
  const uptime = knownDays.length > 0
    ? knownDays.reduce((total, entry) => total + entry.uptimePct, 0) / knownDays.length
    : service.uptimePct;

  return (
    <div className={`min-w-0 px-5 py-6 sm:px-6 ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold leading-tight text-gray-900 dark:text-gray-100">{serviceLabel}</h2>
        <Tooltip
          showArrow
          delay={0}
          classNames={{
            content: 'rounded-md border border-gray-200 bg-white px-4 py-3 text-left text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100',
          }}
          content={
            <div className="space-y-1 text-sm">
              <div className="font-semibold">{serviceLabel}</div>
              <div>{t('status.statusLine', { status: getServiceStatusLabel(service.status, t) })}</div>
              <div>{t('status.lastChecked', { time: formatTime(service.lastCheckedAt, t) })}</div>
              {service.latencyMs !== null && <div>{t('status.latency', { ms: service.latencyMs })}</div>}
            </div>
          }
        >
          <Chip
            aria-label={`${serviceLabel}: ${getServiceStatusLabel(service.status, t)}`}
            color={getServiceColor(service.status)}
            variant="flat"
            size="sm"
            className="h-8 min-w-8 cursor-help px-2"
          >
            <ServiceStatusIcon status={service.status} />
            <span className="sr-only">{getServiceStatusLabel(service.status, t)}</span>
          </Chip>
        </Tooltip>
      </div>
      <div className="flex h-12 items-stretch gap-px sm:gap-0.5 lg:gap-[3px]">
        {days.map((day) => {
          const dayService = reportByDate.get(day)?.services?.[service.id];
          const dayStatus = getServiceStatusLabel(dayService?.status || 'unknown', t);
          return (
            <Tooltip
              key={`${service.id}-${day}`}
              showArrow
              delay={0}
              closeDelay={0}
              classNames={{
                content: 'rounded-md border border-gray-200 bg-white px-4 py-3 text-left text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100',
              }}
              content={
                <div className="space-y-1 text-sm">
                  <div className="font-semibold">{formatDate(day)}</div>
                  <div>{serviceLabel}: {dayStatus}</div>
                  {dayService?.lastCheckedAt && <div>{t('status.lastChecked', { time: formatTime(dayService.lastCheckedAt, t) })}</div>}
                  {dayService?.latencyMs !== null && dayService?.latencyMs !== undefined && (
                    <div>{t('status.latency', { ms: dayService.latencyMs })}</div>
                  )}
                </div>
              }
            >
              <button
                type="button"
                className={`min-w-0 flex-1 cursor-help rounded-[2px] border-0 p-0 transition duration-150 hover:-translate-y-0.5 hover:scale-y-110 hover:brightness-125 hover:ring-2 hover:ring-gray-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:hover:ring-white/40 ${getBarClass(dayService?.status)}`}
                aria-label={t('status.dayStatus', { service: serviceLabel, date: formatDate(day), status: dayStatus })}
              />
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-3 text-sm font-medium text-gray-500 dark:text-gray-400 sm:gap-4">
        <span>{t('status.daysAgo')}</span>
        <div className="h-px bg-gray-300 dark:bg-gray-700" />
        <span className="font-semibold">{t('status.uptimePct', { percent: uptime.toFixed(2) })}</span>
        <div className="h-px bg-gray-300 dark:bg-gray-700" />
        <span>{t('status.today')}</span>
      </div>
    </div>
  );
}

export default function StatusDashboard({
  reports,
  unavailable,
}: {
  reports: PublicStatusReport[];
  unavailable: boolean;
}) {
  const { t } = useI18n();
  const latest = reports[0] || null;
  const latestServices = latest ? STATUS_SERVICE_IDS.map((id) => latest.services[id]) : [];
  const overallStatus = latest?.overallStatus || 'unknown';
  const hasNoReportsYet = !unavailable && reports.length === 0;

  return (
    <div className="min-h-screen bg-background text-foreground [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',Roboto,Helvetica,Arial,sans-serif] dark:bg-dark-bg">
      <Navigation />

      <main className="mx-auto w-full max-w-7xl px-4 pb-20 pt-28 sm:px-6 lg:px-8">
        <section className="mb-10">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 text-gray-800 dark:text-gray-100">
                <FiActivity className="h-7 w-7" />
                <h1 className="text-3xl font-semibold">{t('status.title')}</h1>
              </div>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                {t('status.subtitle')}
              </p>
            </div>
            <Chip
              color={getOverallColor(overallStatus)}
              variant="flat"
              size="lg"
              startContent={<StatusIcon status={overallStatus} />}
            >
              {overallLabel(overallStatus, t)}
            </Chip>
          </div>

          {unavailable && (
            <Card radius="sm" shadow="none" className="border border-gray-200 bg-white/70 dark:border-gray-700 dark:bg-content-bg">
              <CardBody className="text-sm text-gray-700 dark:text-gray-300">
                {t('status.unavailable')}
              </CardBody>
            </Card>
          )}

          {hasNoReportsYet && (
            <Card radius="sm" shadow="none" className="border border-gray-200 bg-white/70 dark:border-gray-700 dark:bg-content-bg">
              <CardBody className="text-sm text-gray-700 dark:text-gray-300">
                {t('status.noReports')}
              </CardBody>
            </Card>
          )}
        </section>

        {latest && (
          <section className="mb-14">
            <div className="mb-4 flex justify-end text-base font-medium text-gray-500 dark:text-gray-400">
              {t('status.uptimeHeading')}
            </div>
            <Card radius="sm" shadow="none" className="border border-gray-200 bg-white dark:border-gray-700 dark:bg-content-bg">
              <CardBody className="grid p-0 md:grid-cols-2">
                {latestServices.map((service, index) => (
                  <UptimeRow
                    key={service.id}
                    service={service}
                    reports={reports}
                    className={getServiceBorderClass(index, latestServices.length)}
                  />
                ))}
              </CardBody>
            </Card>
          </section>
        )}

        <section>
          <h2 className="mb-8 text-3xl font-semibold text-gray-900 dark:text-gray-100">{t('status.pastIncidents')}</h2>
          {reports.length === 0 && (
            <p className="text-gray-600 dark:text-gray-400">
              {hasNoReportsYet
                ? t('status.noneWritten')
                : t('status.noHistory')}
            </p>
          )}

          {reports.length > 0 && (
            <Accordion
              variant="light"
              selectionMode="multiple"
              defaultExpandedKeys={latest ? [latest.date] : []}
              className="border-t border-gray-200 px-0 dark:border-gray-700"
              itemClasses={{
                base: 'border-b border-gray-200 px-0 dark:border-gray-700',
                title: 'text-xl font-semibold text-gray-900 dark:text-gray-100',
                trigger: 'px-0 py-5 data-[hover=true]:bg-transparent',
                content: 'px-0 pb-6 pt-0',
              }}
            >
              {reports.slice(0, 14).map((report) => {
                const dayIncidents = report.incidents;
                const incidentStatusLabel = getDailyIncidentStatusLabel(report, t);
                return (
                  <AccordionItem
                    key={report.date}
                    aria-label={t('status.incidentsAria', { date: formatDate(report.date) })}
                    title={
                      <span className="flex flex-wrap items-center gap-3">
                        <span>{formatDate(report.date)}</span>
                        <Chip color={getDailyIncidentColor(report)} variant="flat" size="sm">
                          {incidentStatusLabel}
                        </Chip>
                      </span>
                    }
                    subtitle={
                      <span className="text-sm text-gray-600 dark:text-gray-400">
                        {getDailyIncidentLabel(report, t, latest?.date)}
                      </span>
                    }
                  >
                    {dayIncidents.length === 0 ? (
                      <p className="text-lg text-gray-600 dark:text-gray-400">
                        {report.date === latest?.date ? t('status.noneToday') : t('status.noneReported')}
                      </p>
                    ) : (
                      <div className="space-y-4">
                        {dayIncidents.map((incident) => (
                          <div key={incident.id}>
                            <div className={incident.severity === 'major' || incident.severity === 'critical' ? 'text-lg font-semibold text-red-600' : 'text-lg font-semibold text-amber-500'}>
                              {incident.title}
                            </div>
                            <p className="mt-2 text-gray-700 dark:text-gray-300">{incident.summary}</p>
                            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{formatIncidentWindow(incident, t)}</p>
                          </div>
                        ))}
                        {report.analysis.summary && (
                          <p className="text-sm text-gray-500 dark:text-gray-400">{report.analysis.summary}</p>
                        )}
                      </div>
                    )}
                  </AccordionItem>
                );
              })}
            </Accordion>
          )}
        </section>
      </main>
    </div>
  );
}
