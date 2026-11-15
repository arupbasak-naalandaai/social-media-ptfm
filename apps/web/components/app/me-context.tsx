"use client"

import { createContext, Suspense, use, type ReactNode } from "react"
import { allowedPlatforms, can, type PermissionMap, type Platform } from "@inbox/core"
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

/** True when the current member has every requested permission. Suspends like useMe. */
export function useCan(request: PermissionMap): boolean {
  return can(useMe().permissions, request)
}

/** Platforms the current member can see. Suspends like useMe. */
export function usePlatforms(): Platform[] {
  return allowedPlatforms(useMe().permissions)
}

/**
 * Renders `children` only when the member has the permissions (else `fallback`). Has its own
 * Suspense boundary, so it's safe anywhere, including the static shell. The api re-checks.
 */
export function IfCan({
  request,
  children,
  fallback = null,
}: {
  request: PermissionMap
  children: ReactNode
  fallback?: ReactNode
}) {
  return (
    <Suspense fallback={null}>
      <IfCanInner request={request} fallback={fallback}>
        {children}
      </IfCanInner>
    </Suspense>
  )
}

function IfCanInner({
  request,
  children,
  fallback,
}: {
  request: PermissionMap
  children: ReactNode
  fallback: ReactNode
}) {
  return useCan(request) ? children : fallback
}
