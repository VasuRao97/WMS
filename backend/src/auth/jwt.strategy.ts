import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { type AuthUser } from '../common/tenant.util';

// The signed JWT payload shape (auth.service.ts's `buildAuthResponse()` is
// the only place that signs one) — not itself validated by this library
// (passport-jwt only verifies the signature/expiry), so still typed loosely
// on purpose rather than trusted as AuthUser until validate() below builds
// the real, freshly-DB-checked one.
interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  companyId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'change-me-in-production',
    });
  }

  // Re-checks `isActive` against the DB on every authenticated request — a
  // signature-valid, unexpired token alone isn't enough. Without this, a
  // deactivated user's already-issued token kept working for up to the 8h
  // token lifetime (auth.module.ts's `expiresIn`) regardless of deactivation,
  // since nothing else in the request path re-reads the User row. Fixed
  // 2026-08-24 — see CLAUDE.md's "Role & Access model" for the full context.
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role as AuthUser['role'],
      companyId: payload.companyId,
    };
  }
}
