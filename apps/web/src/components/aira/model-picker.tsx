import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { ModelSpec } from '@/lib/gateway';

export default function ModelPicker({ models, value, onChange, disabled = false }: {
  models: ModelSpec[]; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  return <Select value={value} onValueChange={next => onChange(String(next ?? ''))} disabled={disabled}>
    <SelectTrigger className="model-picker" aria-label="Model"><SelectValue>{() => models.find(model => model.id === value)?.label ?? 'Auto'}</SelectValue></SelectTrigger>
    <SelectContent alignItemWithTrigger={false} className="model-options">
      <SelectItem value="">Auto · workspace default</SelectItem>
      {models.map(model => {
        /* A local model costs nothing and works with the network off. That is
         * the difference a person actually chooses on, so it is what the row
         * says — ahead of the provider name, which for these is an
         * implementation detail. */
        const local = model.provider === 'ollama';
        return <SelectItem key={model.id} value={model.id}>
          <span>
            {model.label}
            <small>{local ? 'on this Mac · free' : model.provider} · {model.tier}</small>
          </span>
        </SelectItem>;
      })}
    </SelectContent>
  </Select>;
}
