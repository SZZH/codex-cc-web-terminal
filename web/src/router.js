import { createRouter, createWebHashHistory } from "vue-router";

const routes = [
  {
    path: "/",
    redirect: "/sessions"
  },
  {
    path: "/login",
    name: "login"
  },
  {
    path: "/sessions",
    name: "sessions"
  },
  {
    path: "/chat/:sessionId",
    name: "chat",
    props: true
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/sessions"
  }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});

