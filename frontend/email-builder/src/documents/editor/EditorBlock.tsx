import React, { createContext, useContext } from 'react';

import { EditorBlock as CoreEditorBlock } from './core';
import { useDocument } from './EditorContext';
import {advancedTypes,advancedHTML} from '../../../../../outreach/public/marketing/builder-blocks.js';
import EditorBlockWrapper from '../blocks/helpers/block-wrappers/EditorBlockWrapper';

const EditorBlockContext = createContext<string | null>(null);
export const useCurrentBlockId = () => useContext(EditorBlockContext)!;

type EditorBlockProps = {
  id: string;
};

/**
 *
 * @param id - Block id
 * @returns EditorBlock component that loads data from the EditorDocumentContext
 */
export default function EditorBlock({ id }: EditorBlockProps) {
  const document = useDocument();
  const block = document[id];
  if (!block) {
    throw new Error('Could not find block');
  }
  if(advancedTypes.includes(block.type)){
    let html='';try{html=advancedHTML(block.type,block.data.props||{});}catch(error){return <p role="alert">{String(error.message)}</p>;}
    return <EditorBlockContext.Provider value={id}><EditorBlockWrapper><div dangerouslySetInnerHTML={{__html:html}}/></EditorBlockWrapper></EditorBlockContext.Provider>;
  }
  return (
    <EditorBlockContext.Provider value={id}>
      <CoreEditorBlock {...block} />
    </EditorBlockContext.Provider>
  );
}
