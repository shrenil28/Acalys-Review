export interface Workspace {
  id: string;
  name: string;
  avatarUrl: string;
  provider: "github" | "gitlab" | "azure";
}

export interface SessionUser {
  id: string;
  name: string;
  /** Preferred name for greetings. */
  firstName: string;
  /** Git provider handle — what tables and audit rows show. */
  handle: string;
  email: string;
  role: "Admin" | "Member";
  avatarUrl: string;
}

export const workspaces: Workspace[] = [
  {
    id: "shrenil28",
    name: "shrenil28",
    avatarUrl: "https://avatars.githubusercontent.com/u/217703268?s=80&v=4",
    provider: "github",
  },
  {
    id: "acalys-labs",
    name: "acalys-labs",
    avatarUrl: "https://avatars.githubusercontent.com/u/9919?s=80&v=4",
    provider: "github",
  },
  {
    id: "felicity-org",
    name: "felicity-org",
    avatarUrl: "https://avatars.githubusercontent.com/u/6412038?s=80&v=4",
    provider: "gitlab",
  },
];

export const currentUser: SessionUser = {
  id: "u_1",
  name: "Patel Shrenil Shaileshkumar",
  firstName: "Shrenil",
  handle: "shrenil28",
  email: "shrenilshaileshkumar@gmail.com",
  role: "Admin",
  avatarUrl: "https://avatars.githubusercontent.com/u/217703268?v=4",
};
