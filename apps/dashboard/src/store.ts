import { create } from "zustand"
import type { PublishTask } from "@temu-ai-ops/shared"

type DashboardState = {
  activeTaskId: string | null
  setActiveTaskId: (taskId: string) => void
  tasks: PublishTask[]
  setTasks: (tasks: PublishTask[]) => void
}

export const useDashboardStore = create<DashboardState>((set) => ({
  activeTaskId: null,
  setActiveTaskId: (taskId) => set({ activeTaskId: taskId }),
  tasks: [],
  setTasks: (tasks) => set({ tasks })
}))
