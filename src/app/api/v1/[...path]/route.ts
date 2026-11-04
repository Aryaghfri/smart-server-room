// Endpoint akses wajah dan kunci sudah diganti revisi PIR, MQ, dan DHT pada API v2.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  await context.params;
  return Response.json({error:{code:'API_RETIRED',message:'Gunakan /api/v2 untuk monitoring DHT, PIR, dan MQ.'}},{status:410});
}
export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
