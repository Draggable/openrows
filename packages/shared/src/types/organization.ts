export interface Organization {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isPersonal: boolean;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  createdAt: Date;
  updatedAt: Date;
}
