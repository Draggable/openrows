// The API shape of a base is `Base` in ../schemas/base.ts.

export interface BasePermission {
  id: string;
  baseId: string;
  userId: string | null;
  teamId: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BaseShare {
  id: string;
  baseId: string;
  token: string;
  role: string;
  password: string | null;
  expiresAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}
