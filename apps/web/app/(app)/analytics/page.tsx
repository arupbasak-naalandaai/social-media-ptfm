import type { Metadata } from "next"
import { PlaceholderPage } from "@/components/app/placeholder-page"

export const metadata: Metadata = { title: "Analytics" }

export default function Page() {
  return <PlaceholderPage href="/analytics" />
}
