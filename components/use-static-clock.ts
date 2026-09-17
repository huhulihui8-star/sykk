'use client';
import { useEffect, useState } from 'react';
export function useStaticClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_STATIC_EXPORT !== '1') return;
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, []);
  return now;
}
