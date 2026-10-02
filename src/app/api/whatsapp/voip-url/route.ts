import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

export async function GET() {
  try {
    await getCurrentAccount();
    return NextResponse.json({ url: '/api/calls' });
  } catch (error) { return toErrorResponse(error); }
}
