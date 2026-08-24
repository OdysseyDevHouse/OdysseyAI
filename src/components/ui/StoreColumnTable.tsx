import type { ReactNode } from "react";
import {
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
  TABLE_HEAD_STICKY,
} from "./styles";
import { TableScroller } from "./TableScroller";

/**
 * A row per thing, a column per store, a group total on the right.
 *
 * Nearly every cross-store report is this table: stock on hand by product,
 * sales by department, price differences, transfer volumes. Building it once
 * means the hard part is solved once — and the hard part is not the layout.
 *
 * ── THE HARD PART: A DASH IS NOT A ZERO ──────────────────────────────────
 *
 * `null` means THIS STORE DOES NOT CARRY THIS LINE. `0` means it carries it and
 * has none. Collapsing the two is the mistake that makes a cross-store report
 * actively misleading: on a rebalancing report, "not stocked here" and "sold
 * out here" call for opposite actions — leave it alone, or send stock today.
 * The consolidated P&L already draws this distinction for accounts a store's
 * chart lacks; this is the same rule one level down, for products a store does
 * not range.
 *
 * So `null` renders as a dash and is excluded from the row total, while `0`
 * renders as a real zero and counts. Callers must pass `null` deliberately.
 *
 * ── SERVER-RENDERABLE ────────────────────────────────────────────────────
 *
 * No hooks and no handlers, so it stays a server component and a page using it
 * needs no client wrapper — unlike DataTable, whose column definitions carry
 * render functions and cannot cross the boundary.
 *
 * The scroll box IS a client component (TableScroller, which measures the room
 * below it), but that is a child rendered from here rather than a hook called
 * here — a server component may render a client one, so this stays server-side.
 */

export type StoreColumn = {
  siteId: number;
  name: string;
  /** Rendered muted, so a store that could not be read still holds its column. */
  failed?: boolean;
};

export type StoreRow = {
  /** Stable key — a product code, an account code, a department id. */
  key: string;
  /** The row's identity, leftmost. A string, or a code-plus-name cell. */
  label: ReactNode;
  /**
   * One entry per column, in the same order as `columns`. `null` is "not
   * carried here" and renders as a dash; `0` is a real zero.
   */
  values: (number | null)[];
  /** Overrides the computed row total — for a row whose total is not a sum. */
  total?: number;
};

export function StoreColumnTable({
  columns,
  rows,
  format,
  firstHeading = "Item",
  totalHeading = "Total",
  totalsRow,
  totalsLabel = "All stores",
  emptyNote,
}: {
  columns: StoreColumn[];
  rows: StoreRow[];
  /** How a figure is written — money, a quantity, a percentage. */
  format: (value: number) => string;
  firstHeading?: string;
  totalHeading?: string;
  /**
   * The footer, one figure per column. Passed in rather than summed here: a
   * column of percentages or averages does not foot by addition, and a table
   * that silently adds them up would print a confidently wrong number.
   */
  totalsRow?: (number | null)[];
  totalsLabel?: string;
  /** Shown under the table — what a dash means, where the figures came from. */
  emptyNote?: ReactNode;
}) {
  const totalOf = (row: StoreRow): number =>
    row.total ??
    row.values.reduce<number>((t, v) => (v === null ? t : t + v), 0);

  const footTotal =
    totalsRow?.reduce<number>((t, v) => (v === null ? t : t + v), 0) ??
    rows.reduce((t, r) => t + totalOf(r), 0);

  return (
    <>
      <TableScroller>
        <table className={TABLE}>
          <thead className={TABLE_HEAD_STICKY}>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TABLE_TH}>{firstHeading}</th>
              {columns.map((c) => (
                <th
                  key={c.siteId}
                  className={`${TABLE_TH} ${TABLE_NUMERIC} ${c.failed ? "text-faint" : ""}`}
                >
                  {c.name}
                </th>
              ))}
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{totalHeading}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={TABLE_ROW}>
                <td className={TABLE_TD}>{row.label}</td>
                {row.values.map((value, i) => (
                  <td
                    key={columns[i]?.siteId ?? i}
                    className={`${TABLE_TD} ${TABLE_NUMERIC}`}
                  >
                    {value === null ? (
                      /* Not carried here. Title text because a dash on its own
                         is ambiguous to anyone who has not read the note. */
                      <span
                        className="text-faint"
                        title="Not carried at this store"
                      >
                        —
                      </span>
                    ) : (
                      format(value)
                    )}
                  </td>
                ))}
                <td
                  className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}
                >
                  {format(totalOf(row))}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className={TABLE_TOTAL_ROW}>
                <td className={`${TABLE_TD} font-semibold`}>{totalsLabel}</td>
                {(totalsRow ?? columnSums(columns, rows)).map((value, i) => (
                  <td
                    key={columns[i]?.siteId ?? i}
                    className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}
                  >
                    {value === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      format(value)
                    )}
                  </td>
                ))}
                <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                  {format(footTotal)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </TableScroller>

      {emptyNote && <p className="px-4 py-3 text-xs text-muted">{emptyNote}</p>}
    </>
  );
}

/**
 * Column sums, where a column of nothing but dashes stays a dash.
 *
 * A store that ranges none of these lines has no total — printing 0 would claim
 * it stocks them all and has none of any, which is the opposite of true.
 */
function columnSums(
  columns: StoreColumn[],
  rows: StoreRow[],
): (number | null)[] {
  return columns.map((_, i) => {
    let sum = 0;
    let sawValue = false;
    for (const row of rows) {
      const v = row.values[i];
      if (v !== null && v !== undefined) {
        sum += v;
        sawValue = true;
      }
    }
    return sawValue ? sum : null;
  });
}
