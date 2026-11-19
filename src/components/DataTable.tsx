import React, { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { exportRowsToCsv } from '../lib/api.ts';

export interface TableColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  render: (row: T) => React.ReactNode;
  csvValue?: (row: T) => string | number;
}

interface FilterOption {
  value: string;
  label: string;
}

interface DataTableProps<T> {
  title: string;
  subtitle?: string;
  rows: T[];
  columns: TableColumn<T>[];
  searchPlaceholder?: string;
  getSearchText: (row: T) => string;
  filterOptions?: FilterOption[];
  getFilterValue?: (row: T) => string;
  enableDateFilter?: boolean;
  getDateValue?: (row: T) => string;
  toolbarExtra?: React.ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  exportFilename?: string;
}

export function DataTable<T>({
  title,
  subtitle,
  rows,
  columns,
  searchPlaceholder = 'রেকর্ড খুঁজুন...',
  getSearchText,
  filterOptions,
  getFilterValue,
  enableDateFilter = false,
  getDateValue,
  toolbarExtra,
  emptyTitle,
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  exportFilename = 'zentopay-export.csv',
}: DataTableProps<T>) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;

    return rows.filter((row) => {
      if (activeFilter !== 'all' && getFilterValue) {
        if (getFilterValue(row) !== activeFilter) return false;
      }
      if ((fromMs !== null || toMs !== null) && getDateValue) {
        const rawDate = getDateValue(row);
        const rowMs = rawDate ? new Date(rawDate).getTime() : NaN;
        if (Number.isNaN(rowMs)) return false;
        if (fromMs !== null && rowMs < fromMs) return false;
        if (toMs !== null && rowMs > toMs) return false;
      }
      if (!q) return true;
      return getSearchText(row).toLowerCase().includes(q);
    });
  }, [rows, query, activeFilter, dateFrom, dateTo, getFilterValue, getDateValue, getSearchText]);

  const handleExport = () => {
    if (filteredRows.length === 0) return;
    const csvRows = filteredRows.map((row) => {
      const record: Record<string, unknown> = {};
      columns.forEach((col) => {
        record[col.header] = col.csvValue ? col.csvValue(row) : '';
      });
      return record;
    });
    exportRowsToCsv(exportFilename, csvRows);
  };

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="p-5 border-b border-slate-200 flex flex-col gap-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {toolbarExtra}

            {filterOptions && filterOptions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg max-w-full">
                {filterOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setActiveFilter(opt.value)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      activeFilter === opt.value
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            <div className="relative w-full sm:w-auto">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/15 w-full sm:w-60"
              />
            </div>

            <button
              type="button"
              onClick={handleExport}
              disabled={filteredRows.length === 0}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              CSV ডাউনলোড
            </button>
          </div>
        </div>

        {enableDateFilter && getDateValue && (
          <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100 text-xs">
            <span className="font-semibold text-slate-500">তারিখ ফিল্টার:</span>
            <input
              type="date"
              aria-label="শুরুর তারিখ"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            />
            <span className="text-slate-400">থেকে</span>
            <input
              type="date"
              aria-label="শেষ তারিখ"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            />
            {(dateFrom || dateTo || query || activeFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setDateFrom('');
                  setDateTo('');
                  setQuery('');
                  setActiveFilter('all');
                }}
                className="px-2.5 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
              >
                ফিল্টার রিসেট
              </button>
            )}
          </div>
        )}
      </div>

      {filteredRows.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm font-semibold text-slate-900">{emptyTitle}</p>
          <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">{emptyDescription}</p>
          {emptyActionLabel && onEmptyAction && (
            <button
              type="button"
              onClick={onEmptyAction}
              className="mt-5 inline-flex items-center justify-center px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors cursor-pointer"
            >
              {emptyActionLabel}
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-5 py-3 text-xs font-semibold text-slate-600 whitespace-nowrap ${
                      col.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.map((row, idx) => (
                <tr key={idx} className="hover:bg-slate-50/70 transition-colors">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-5 py-3.5 text-sm text-slate-700 whitespace-nowrap ${
                        col.align === 'right' ? 'text-right tabular-nums' : 'text-left'
                      }`}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
