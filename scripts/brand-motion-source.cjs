/* JobsAI native vector motion, adapted from the approved blue-card/glove image.
 * Orthographic face projection follows the ISO-GLOW / OFFPEAK workflow.
 * This is a layered vector relief, not a volumetric model or an AI video.
 * Original reference PNG remains unchanged. All coordinates are editable.
 */
const C = {paper:'#F3EDE6', cream:'#FFFDFA', ink:'#212833', blue:'#0061FE', edge:'#244BA8'};
const DURATION = 6;
const f = n => +n.toFixed(5);
const pth = (d, fill, sw=19, extra='') => `<path d="${d}" fill="${fill}" stroke="${C.ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const card = 'M460 243 L765 215 C808 211 839 241 843 280 L874 644 C879 702 813 754 740 774 C692 788 638 788 605 778 L418 771 L383 326 C378 282 408 248 460 243 Z';
const cuff = 'M575 950 C650 978 752 959 823 918 L857 959 C874 986 846 1008 810 1023 C746 1050 666 1058 613 1042 C584 1034 567 1019 566 990 Z';
const palm = 'M479 700 C537 687 607 786 689 779 C727 775 745 736 770 705 C729 689 695 666 686 632 C676 599 685 566 708 546 C734 523 758 535 783 557 C814 585 840 602 872 623 C903 644 918 677 917 714 C916 793 884 853 826 900 L817 908 C820 910 823 909 826 907 C758 965 674 988 590 967 C531 954 487 936 462 903 L439 823 Z';
const fingers = [
 'M395 549 C365 552 341 575 338 605 C334 632 348 655 371 670 L459 634 C468 615 464 589 447 569 C435 554 415 545 395 549 Z',
 'M398 638 C425 618 464 613 492 628 C517 641 534 664 529 685 C523 711 497 734 464 754 C431 775 400 787 379 766 C351 742 358 706 377 677 C382 661 388 647 398 638 Z',
 'M431 722 C462 702 500 692 530 700 C557 706 576 727 579 748 C583 773 562 796 534 817 C504 841 474 862 444 861 C415 861 392 842 390 817 C388 785 406 748 431 722 Z',
 'M538 898 C566 887 596 868 608 846 C622 823 602 801 577 795 C544 787 508 803 482 826 C457 848 445 874 456 898 C468 921 492 932 518 937'
];

function matrix(yaw,pitch,roll,z) {
 const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),cr=Math.cos(roll),sr=Math.sin(roll);
 const project=(x,y,d)=>{const a=cy*x+sy*d,b=cp*y+sp*sy*x-sp*cy*d;return [(a*cr-b*sr)*.94,(a*sr+b*cr)*.94];};
 const a=project(1,0,0),b=project(0,1,0),o=project(-626,-630,z);
 return `matrix(${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])} ${f(o[0]+627)} ${f(o[1]+627)})`;
}

function frame(time,{size=1080,transparent=false}={}) {
 const t=((time%DURATION)+DURATION)%DURATION,q=t/DURATION*Math.PI*2;
 const turn=Math.sin(q), squeeze=Math.pow(Math.sin(q/2),4);
 const yaw=.46*turn,pitch=.17*turn,roll=-.035*turn;
 const lift=8*squeeze,checkScale=1+.045*Math.pow(Math.sin(q),8);
 const plane=(z,s)=>`<g transform="${matrix(yaw,pitch,roll,z)}">${s}</g>`;
 let body='';
 // Cuff and card have real projected back/front planes with shallow depth.
 body+=plane(-8,pth(cuff,C.ink));
 body+=plane(0,pth(cuff,C.blue));
 const cardFace=`<g transform="translate(0 ${f(-lift)})">${pth(card,C.blue)}</g>`;
 // Closely spaced solid slices join the rounded silhouette without seams.
 for(let z=-18;z<10;z+=2)body+=plane(z,`<g transform="translate(0 ${f(-lift)})">${pth(card,C.edge)}</g>`);
 body+=plane(12,cardFace);
 body+=plane(13,`<g transform="translate(626 ${f(440-lift)}) scale(${f(checkScale)}) translate(-626 -440)"><path d="M515 452 L585 520 L735 360" fill="none" stroke="${C.cream}" stroke-width="80" stroke-linecap="round" stroke-linejoin="round"/></g>`);
 // The hand stays around the card. The palm and knuckles articulate separately.
 body+=plane(25,`<g transform="translate(${f(-2*squeeze)} 0)">${pth(palm,C.cream)}<path d="M770 705 C748 728 737 768 733 801" fill="none" stroke="${C.ink}" stroke-width="13" stroke-linecap="round"/></g>`);
 for(let i=0;i<fingers.length;i++) {
   const shift=(1.4+i*.55)*squeeze;
   body+=plane(29+i*.8,`<g transform="translate(${f(shift)} ${f(-shift*.65)})">${pth(fingers[i],C.cream)}</g>`);
 }
 return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1254 1254" role="img" aria-label="JobsAI blue checked card held by an ivory glove">${transparent?'':`<path d="M0 0H1254V1254H0Z" fill="${C.paper}"/>`}${body}</svg>`);
}

module.exports={frame,C,DURATION};
