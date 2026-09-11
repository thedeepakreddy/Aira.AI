import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { ModelSpec } from '@/lib/gateway';

export default function ModelPicker({ models, value, onChange, disabled = false }: {
  models: ModelSpec[]; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  return <Select value={value} onValueChange={next => onChange(String(next ?? ''))} disabled={disabled}>
    <SelectTrigger className="model-picker" aria-label="Model"><SelectValue>{() => models.find(model => model.id === value)?.label ?? 'Auto'}</SelectValue></SelectTrigger>
    <SelectContent alignItemWithTrigger={false} className="model-options">
      <SelectItem value="">Auto · workspace default</SelectItem>
      {models.map(model => <SelectItem key={model.id} value={model.id}><span>{model.label}<small>{model.provider} · {model.tier}</small></span></SelectItem>)}
    </SelectContent>
  </Select>;
}
