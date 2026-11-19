import React, { useState } from 'react';

export function ZentoPayEmblem({ size = 44 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="zp_emblem_grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0B7A4A" />
          <stop offset="100%" stopColor="#043824" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill="url(#zp_emblem_grad)" />
      <path
        d="M15 16.5H33L18.5 31.5H33"
        stroke="#FFFFFF"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 31.5H19"
        stroke="#52E5A5"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const METHOD_META: Record<
  string,
  { label: string; bg: string; img?: string }
> = {
  bkash: { label: 'bKash', bg: '#D12053', img: '/assets/bkash.jpg' },
  nagad: { label: 'Nagad', bg: '#F7931E', img: '/assets/nagad.png' },
  rocket: { label: 'Rocket', bg: '#8C3494', img: '/assets/rocket.png' },
  bank: { label: 'Bank', bg: '#075B3A' },
};

export function MethodLogo({
  method,
  size = 48,
}: {
  method: string;
  size?: number;
}) {
  const [imgError, setImgError] = useState(false);
  const key = method.trim().toLowerCase();
  const customMonogram = key.replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase() || 'BDT';
  const meta = METHOD_META[key] || { label: customMonogram, bg: '#075B3A' };

  if (meta.img && !imgError) {
    return (
      <div
        className="rounded-full overflow-hidden flex items-center justify-center shrink-0 border border-black/5 shadow-xs bg-white"
        style={{ width: size, height: size }}
      >
        <img
          src={meta.img}
          alt={meta.label}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-extrabold text-white shadow-xs"
      style={{
        width: size,
        height: size,
        backgroundColor: meta.bg,
        color: '#FFFFFF',
        fontSize: Math.max(10, Math.round(size * 0.24)),
      }}
    >
      {meta.label}
    </div>
  );
}
