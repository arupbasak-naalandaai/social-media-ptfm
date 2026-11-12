"use client"

import { createContext, use, type ReactNode } from "react"
import type { Me } from "@/lib/server-api"

const MeContext = createContext<Promise<Me> | null>(null)

/** Holds the (unawaited) current-user promise; consumers unwrap it behind their own <Suspense>. */
export function MeProvider({
  mePromise,
  children,
}: {
  mePromise: Promise<Me>
  children: ReactNode
}) {
  return <MeContext value={mePromise}>{children}</MeContext>
}

/** Suspends until the user is known: call only inside a <Suspense> boundary. */
export function useMe(): Me {
  const promise = use(MeContext)
  if (!promise) throw new Error("useMe must be used inside <MeProvider>")
  return use(promise)
}

export function useIsAdmin(): boolean {
  const { role } = useMe()
  return role === "owner" || role === "admin"
}
