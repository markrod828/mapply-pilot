import { scoreVerdict } from '@mapply/core/atsScore';

interface Props {
  score: number;
  size?: number;
  label?: string;
}

export function ScoreGauge({ score, size = 84, label }: Props) {
  const verdict = scoreVerdict(score);
  const stroke = 8;
  const radius = size / 2 - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;

  return (
    <div className="gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`ATS score ${score}`}>
        {/* Track colour comes from CSS so it follows the light/dark theme. */}
        <circle className="gauge-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={verdict.color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size / 3.2}
          fontWeight="700"
          fill={verdict.color}
        >
          {score}
        </text>
      </svg>
      <div className="gauge-label" style={{ color: verdict.color }}>
        {label ?? verdict.label}
      </div>
    </div>
  );
}
