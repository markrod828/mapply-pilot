export type WizardStep = 'compare' | 'align' | 'review';

const STEPS: { id: WizardStep; label: string }[] = [
  { id: 'compare', label: 'See your difference' },
  { id: 'align', label: 'Align your resume' },
  { id: 'review', label: 'Review new resume' },
];

interface Props {
  current: WizardStep;
  reachable: WizardStep[];
  onSelect: (step: WizardStep) => void;
}

export function Stepper({ current, reachable, onSelect }: Props) {
  return (
    <ol className="stepper">
      {STEPS.map((step, index) => {
        const state = step.id === current ? 'active' : reachable.includes(step.id) ? 'done' : 'todo';
        return (
          <li key={step.id} className={`step ${state}`}>
            <button
              type="button"
              disabled={!reachable.includes(step.id) && step.id !== current}
              onClick={() => onSelect(step.id)}
            >
              <span className="step-index">{index + 1}</span>
              <span className="step-label">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
