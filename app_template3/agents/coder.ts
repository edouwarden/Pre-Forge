import { existsSync, mkdirSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { Message, query } from '../tools/ai';
import { start, Tools } from './agents';
import { PROJECT_ROOT } from '../tools/paths';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.cache', '.turbo']);
const MAX_FILES = 200;
const MAX_SUMMARIZED_FILES = 20;
const MAX_FILE_BYTES = 50_000;

async function listFiles(directory: string, depth = 0): Promise<string[]> {
    if (depth > 8) return [];

    const entries = await readdir(directory, { withFileTypes: true });
    const fileList: string[] = [];

    for (const entry of entries) {
        if (fileList.length >= MAX_FILES) break;
        if (IGNORED_DIRS.has(entry.name)) continue;

        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            fileList.push(...(await listFiles(fullPath, depth + 1)));
        } else if (entry.isFile()) {
            fileList.push(fullPath);
        }
    }

    return fileList;
}

export async function coder(task: string, chatHistory?: Message[]): Promise<any> {
    const projectDirectory = PROJECT_ROOT;
    if (!existsSync(projectDirectory)) {
        mkdirSync(projectDirectory, { recursive: true });
    }

    const allFiles = await listFiles(projectDirectory);
    let fileResumes: Array<{ name: string; content: string }> = [];

    if (allFiles.length > 0) {
        fileResumes = await Promise.all(
            allFiles.slice(0, MAX_SUMMARIZED_FILES).map(async file => {
                try {
                    let content = await readFile(file, 'utf8');
                    if (content.length > MAX_FILE_BYTES) {
                        content = `${content.slice(0, MAX_FILE_BYTES)}\n… (truncated)`;
                    }
                    const analysis = await query(
                        `${content}\n\nAnalyse le contenu du fichier et donne un court resume de ce que font les fonctions presentes, si elles sont publiques ou non et leur utilisation.`,
                    );
                    return { name: relative(projectDirectory, file), content: String(analysis.data ?? '(no summary)') };
                } catch {
                    return { name: relative(projectDirectory, file), content: '(unreadable file)' };
                }
            }),
        );
    }

    const coder = await start(
        `Tu es un developpeur senior. Ton objectif est de generer un code a partir d'une tache donnee.

Contexte :
- Tu es un expert en TypeScript, qui utilise Bun.
- Tu es attitre a un projet, que tu dois completer selon les instructions donnees par l'utilisateur.
- Tu peux utiliser les outils suivants :
    - ${Tools.WRITE_FILE} : pour ecrire un fichier ou modifier un fichier existant
    - ${Tools.READ_FILE} : pour lire un fichier
    - ${Tools.EXECUTE_COMMAND} : pour executer une commande
    - ${Tools.ASK_USER} : UNIQUEMENT pour demander a l'utilisateur une information externe a ton contexte, tel que des informations de connexion.
- Il est preferable d'executer une commande a la fois, mais tu peux executer plusieurs commandes en meme temps si elles sont independantes.
- Tu dois toujours lire 1 fois les fichiers existants avant de les modifier.
- Toutes tes commandes seront executees a la racine du projet, tu ne peux pas changer de dossier.
- Tu peux utiliser le chemin absolu ${projectDirectory} ou le chemin relatif ./ pour acceder au projet.

Voici les fichiers du projet :
${fileResumes.length > 0 ? fileResumes.map(file => `${file.name}\n${file.content}`).join('\n') : 'Le projet est vide'}
Chemin absolu du projet : ${projectDirectory}
Tu peux les modifier, les lire, les executer, les supprimer, ou en creer.

Commence des maintenant en attendant un message utilisateur.`,
        [Tools.WRITE_FILE, Tools.READ_FILE, Tools.EXECUTE_COMMAND, Tools.ASK_USER],
        task,
        chatHistory,
        undefined,
        {
            model: process.env.CODER_MODEL || 'cohere/north-mini-code:free',
        },
    );

    return coder;
}
