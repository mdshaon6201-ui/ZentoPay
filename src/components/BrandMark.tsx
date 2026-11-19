import React from 'react';

interface BrandMarkProps {
  className?: string;
  inverted?: boolean;
}

export function BrandMark({ className = '', inverted = false }: BrandMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 ${className}`}>
      <svg
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect
          width="28"
          height="28"
          rx="7"
          fill={inverted ? '#FFFFFF' : '#059669'}
        />
        <path
          d="M8.5 9.5H19.5L11.5 18.5H19.5"
          stroke={inverted ? '#047857' : '#FFFFFF'}
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8.5 18.5H11.5"
          stroke={inverted ? '#10B981' : '#A7F3D0'}
          strokeWidth="2.3"
          strokeLinecap="round"
        />
      </svg>
      <span
        className={`font-display text-lg font-bold tracking-tight ${
          inverted ? 'text-white' : 'text-slate-900'
        }`}
      >
        ZentoPay
      </span>
    </span>
  );
}
