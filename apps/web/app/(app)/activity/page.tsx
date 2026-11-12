import type { Metadata } from "next"
import { PlaceholderPage } from "@/components/app/placeholder-page"

export const metadata: Metadata = { title: "Activity log" }

export default function Page() {
  return <PlaceholderPage href="/activity" />
}
