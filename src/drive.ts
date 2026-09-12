import { google } from "googleapis";

import {
  googleOAuthClient,
  isGoogleCalendarConnected,
} from "./calendar";


// ============================================================
// SEARCH GOOGLE DRIVE
// ============================================================

export async function searchDriveFiles(
  query: string,
  modifiedAfter?: string | null,
  modifiedBefore?: string | null
) {

  if (!isGoogleCalendarConnected()) {

    throw new Error(
      "Google account is not connected"
    );
  }


  const drive = google.drive({
    version: "v3",
    auth: googleOAuthClient,
  });


  // Palabras que normalmente no ayudan
  // a encontrar el nombre de un archivo.
  const stopWords = new Set([
    "a",
    "al",
    "algo",
    "de",
    "del",
    "el",
    "en",
    "esa",
    "ese",
    "esta",
    "este",
    "informacion",
    "información",
    "la",
    "las",
    "lo",
    "los",
    "mi",
    "mis",
    "por",
    "que",
    "quien",
    "quién",
    "tiene",
    "ultima",
    "última",
    "version",
    "versión",
    "viene",
    "un",
    "una",
    "the",
    "of",
    "my",
    "find",
    "file",
    "document",
    "latest",
    "version",
  ]);


  const terms =
    query
      .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
      .split(/[\s_-]+/)
      .map(
        (term) => term.trim()
      )
      .filter(Boolean)
      .filter(
        (term) =>
          !stopWords.has(
            term.toLowerCase()
          )
      )
      .filter(
        (term) =>
          term.length >= 2 ||
          /^\d+$/.test(term)
      )
      .slice(0, 6);


  console.log(
    "🔎 Drive search terms:",
    terms
  );


  // Filtro de fecha, si el agente detectó una referencia
  // temporal ("ayer", "la semana pasada", etc). Drive acepta
  // comparaciones sobre modifiedTime con timestamps RFC 3339.
  const dateClauses: string[] = [];

  if (modifiedAfter) {

    dateClauses.push(
      `modifiedTime > '${modifiedAfter}'`
    );
  }

  if (modifiedBefore) {

    dateClauses.push(
      `modifiedTime < '${modifiedBefore}'`
    );
  }

  if (dateClauses.length > 0) {

    console.log(
      "🗓️ Drive date filter:",
      dateClauses
    );
  }


  if (
    terms.length === 0 &&
    dateClauses.length === 0
  ) {

    return [];
  }


  const escapeDriveQuery =
    (value: string) =>
      value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'");


  const buildQuery = (
    nameClause: string | null
  ) => {

    const clauses = [
      "trashed = false",
      ...(nameClause ? [nameClause] : []),
      ...dateClauses,
    ];

    return clauses.join(" and ");
  };


  // Ejemplo:
  //
  // constancia IMSS
  //
  // se transforma en:
  //
  // name contains 'constancia'
  // AND
  // name contains 'IMSS'

  const strictNameQuery =
    terms.length > 0
      ? "(" +
        terms
          .map(
            (term) =>
              `name contains '${escapeDriveQuery(term)}'`
          )
          .join(" and ") +
        ")"
      : null;


  let response =
    await drive.files.list({

      q: buildQuery(strictNameQuery),

      pageSize: 25,

      orderBy:
        "modifiedTime desc",

      fields:
        "files(id,name,mimeType,modifiedTime,createdTime,webViewLink,iconLink,owners(displayName,emailAddress))",
    });


  let files =
    response.data.files ?? [];


  // Si la búsqueda estricta no encontró nada,
  // hacemos un segundo intento más amplio.
  if (
    files.length === 0 &&
    terms.length > 1
  ) {

    const broadNameQuery =
      "(" +
      terms
        .map(
          (term) =>
            `name contains '${escapeDriveQuery(term)}'`
        )
        .join(" or ") +
      ")";


    response =
      await drive.files.list({

        q: buildQuery(broadNameQuery),

        pageSize: 25,

        orderBy:
          "modifiedTime desc",

        fields:
          "files(id,name,mimeType,modifiedTime,createdTime,webViewLink,iconLink,owners(displayName,emailAddress))",
      });


    files =
      response.data.files ?? [];
  }


  return files.map(
    (file) => ({

      id:
        file.id ?? null,

      name:
        file.name ??
        "Untitled file",

      mimeType:
        file.mimeType ??
        null,

      modifiedTime:
        file.modifiedTime ??
        null,

      createdTime:
        file.createdTime ??
        null,

      webViewLink:
        file.webViewLink ??
        null,

      iconLink:
        file.iconLink ??
        null,

      owner:
        file.owners?.[0]
          ? {
              name:
                file.owners[0]
                  .displayName ??
                null,

              email:
                file.owners[0]
                  .emailAddress ??
                null,
            }
          : null,
    })
  );
}