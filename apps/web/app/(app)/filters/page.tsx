import type { Metadata } from "next"
import { FiltersPage } from "@/components/filters/filters-page"

export const metadata: Metadata = { title: "Filters" }

export default function Page() {
  return <FiltersPage />
}
