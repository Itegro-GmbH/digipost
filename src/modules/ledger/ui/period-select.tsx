"use client";

import { SELECT_CLASSES } from "./format";
import { usePeriodLabel } from "./period-name";

/** A native period select for a GET form: the option value is the period key ("2026-07",
 * "2026-Q3"), the label its German name. */
export function PeriodSelect({ id, name, periods, value }: { id: string; name: string; periods: readonly { key: string; from: string; to: string }[]; value: string }) {
  const label = usePeriodLabel();
  return (
    <select id={id} name={name} defaultValue={value} className={`${SELECT_CLASSES} w-fit`}>
      {periods.map((period) => (
        <option key={period.key} value={period.key}>
          {label(period.from, period.to)}
        </option>
      ))}
    </select>
  );
}
