import { start, Tools } from "./agents";
import { Message } from "../tools/ai";

export async function think( goal: string ,chatHistory?: Message[]): Promise<any> {
    const plan = await start("Vous êtes un agent de réflexion qui doit repondre a la question de l'utilisateur.",
         [], goal, chatHistory);
    return plan;
}
export async function think_with_tools( goal: string ,chatHistory?: Message[]): Promise<any> {
    const plan = await start("Vous êtes un agent de réflexion qui peut utiliser les outils disponibles pour realiser l'objectif.",
         ["all"], goal, chatHistory);
    return plan;
}