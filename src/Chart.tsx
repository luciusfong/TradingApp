import { useMemo, useRef, useState } from 'react';
import type { Series, Range } from './lib/market';

const W = 360;
const H = 190;
const PAD = { t: 22, r: 46, b: 20, l: 8 };

function fmtTime(t: number, range: Range): string {
  const d = new Date(t);
  if (range === '1D') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (range === '5D') return d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: range === '1Y' ? '2-digit' : undefined });
}

export function Chart({ series, range }: { series: Series; range: Range }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const g = useMemo(() => {
    const { c } = series;
    const all = series.prevClose ? [...c, series.prevClose] : c;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const x = (i: number) => PAD.l + (c.length === 1 ? 0 : (i / (c.length - 1)) * iw);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * ih;
    const path = c.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const ticks = [0, 0.5, 1].map((f) => lo + pad + (hi - lo - 2 * pad) * f);
    return { x, y, path, ticks, iw };
  }, [series]);

  const pick = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.l) / g.iw) * (series.c.length - 1));
    setHover(Math.max(0, Math.min(series.c.length - 1, i)));
  };

  const last = series.c.length - 1;
  const hi = hover ?? last;
  const base = series.prevClose ?? series.c[0];
  const up = series.c[last] >= base;
  const tipLeft = hover === null ? null : Math.min(Math.max((g.x(hover) / W) * 100, 12), 78);

  return (
    <div className="chart">
      {hover !== null && (
        <div className="tip num" style={{ left: `${tipLeft}%`, transform: 'translateX(-50%)' }}>
          <b>{series.c[hover].toFixed(2)}</b> {fmtTime(series.t[hover], range)}
        </div>
      )}
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Price chart, ${range}. Latest ${series.c[last].toFixed(2)}, ${up ? 'up' : 'down'} from ${base.toFixed(2)}.`}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) && pick(e.clientX)}
        onPointerUp={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        {g.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={g.y(v)} y2={g.y(v)} stroke="var(--rule)" strokeWidth="1" />
            <text x={W - PAD.r + 6} y={g.y(v) + 4} fontSize="11" fill="var(--ink-3)" className="num">{v.toFixed(v >= 1000 ? 0 : 2)}</text>
          </g>
        ))}
        {series.prevClose !== undefined && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={g.y(series.prevClose)} y2={g.y(series.prevClose)} stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 4" />
            <text x={W - PAD.r} y={g.y(series.prevClose) + 12} fontSize="10" fill="var(--ink-3)" textAnchor="end" stroke="var(--paper)" strokeWidth="3" paintOrder="stroke">Prev close</text>
          </g>
        )}
        <path d={g.path} fill="none" stroke="var(--line)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && <line x1={g.x(hi)} x2={g.x(hi)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth="1" />}
        <circle cx={g.x(hi)} cy={g.y(series.c[hi])} r="4.5" fill="var(--line)" stroke="var(--paper)" strokeWidth="2" />
        <text x={PAD.l} y={H - 5} fontSize="11" fill="var(--ink-3)">{fmtTime(series.t[0], range)}</text>
        <text x={W - PAD.r} y={H - 5} fontSize="11" fill="var(--ink-3)" textAnchor="end">{fmtTime(series.t[last], range)}</text>
      </svg>
    </div>
  );
}
