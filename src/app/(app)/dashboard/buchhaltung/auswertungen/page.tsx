import { redirect } from "next/navigation";

/** "Auswertungen" has no page of its own: its first tab is the USt-VA preview. The target page
 * checks `finance.read` and the ledger itself. */
export default function LedgerReportsPage() {
  redirect("/dashboard/buchhaltung/auswertungen/ust");
}
