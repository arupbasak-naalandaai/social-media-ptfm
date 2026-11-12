import type { Platform } from "@inbox/core"
import { cn } from "cn"

export const PLATFORM_LABELS: Record<Platform, string> = {
  google_business: "Google Business",
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  linkedin: "LinkedIn",
}

/** Simple brand-colored marks (no third-party logo assets). */
const STYLES: Record<Platform, { className: string; glyph: string }> = {
  google_business: {
    className: "bg-white text-[#4285F4] ring-1 ring-border dark:bg-neutral-100",
    glyph: "G",
  },
  facebook: { className: "bg-[#1877F2] text-white", glyph: "f" },
  instagram: {
    className: "bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-white",
    glyph: "◎",
  },
  youtube: { className: "bg-[#FF0000] text-white", glyph: "▶" },
  linkedin: { className: "bg-[#0A66C2] text-white", glyph: "in" },
}

export function PlatformIcon({
  platform,
  className,
  title = true,
}: {
  platform: Platform
  className?: string
  title?: boolean
}) {
  const s = STYLES[platform]
  return (
    <span
      role="img"
      aria-label={PLATFORM_LABELS[platform]}
      title={title ? PLATFORM_LABELS[platform] : undefined}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] leading-none font-bold select-none",
        s.className,
        className,
      )}
    >
      {s.glyph}
    </span>
  )
}
