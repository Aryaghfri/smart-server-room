import { handleMonitoringApi } from "@/lib/monitoring-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  return handleMonitoringApi(request, (await context.params).path);
}
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
